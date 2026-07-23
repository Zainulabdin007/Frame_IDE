/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	FrameAdapterKind,
	FrameAdapterScope,
	FrameAdapterState,
	IFrameAdapterCompatibilityRequest,
	IFrameAdapterCompatibilityResult,
	IFrameAdapterDescriptor,
	IFrameAdapterExportPackage,
	IFrameAdapterMetadata,
	IFrameRegisterAdapterInput,
} from '../common/models.js';
import { resolveAdapterWeightAbsolutePath } from '../runtime/frameAdapterRuntime.js';
import { IFrameAdapterService } from './frameAdapters.js';
import {
	FRAME_BUILTIN_ADAPTER_ID,
	FRAME_BUILTIN_WEIGHT_BASENAME,
	createBuiltinFrameAgentDescriptor,
	getFrameBuiltinAdapterWeightCandidates,
	isFrameBuiltinAdapter,
	isFrameBuiltinAdapterId,
} from './frameBuiltinAdapters.js';

export const FRAME_ADAPTER_PACKAGE_VERSION = 1;
const DEFAULT_BASE_MODEL = 'future-local-base';
const DEFAULT_VERSION = '0.1.0';
/** Reject files smaller than this — real GGUF/safetensors LoRAs are much larger. */
const MIN_WEIGHT_BYTES = 1024;

const WEIGHTS_MD = `# Frame adapter weights

This adapter folder has no LoRA weight file yet.

Place a real **GGUF LoRA** (preferred for node-llama-cpp) or fused GGUF here, then either:

1. Use the Frame sidebar **Link weight path** control with an absolute path to your \`.gguf\` (or \`.safetensors\`) file, or
2. Copy the file into this directory and set \`weightFile\` in \`metadata.json\`.

MLX \`.safetensors\` adapters may not load in node-llama-cpp — convert / fuse to GGUF when possible.

See: \`tools/frame-lora-train/README.md\` → **Get it into Frame**.
`;

/**
 * Persistent adapter registry under `<workspace>/.frame/adapters/`.
 * Writes metadata + WEIGHTS.md instructions — real weights via {@link importWeightFile}.
 */
export class FrameAdapterService extends Disposable implements IFrameAdapterService {

	declare readonly _serviceBrand: undefined;

	private readonly _adapters = new Map<string, IFrameAdapterDescriptor>();
	private _folder: URI | undefined;
	private _discoverPromise: Promise<readonly IFrameAdapterDescriptor[]> | undefined;

	private readonly _onDidChangeAdapters = this._register(new Emitter<readonly IFrameAdapterDescriptor[]>());
	readonly onDidChangeAdapters: Event<readonly IFrameAdapterDescriptor[]> = this._onDidChangeAdapters.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this._discoverPromise = undefined;
			void this.discover();
		}));
		void this.discover();
	}

	async discover(folder?: URI): Promise<readonly IFrameAdapterDescriptor[]> {
		if (this._discoverPromise && !folder) {
			return this._discoverPromise;
		}
		const pending = this.doDiscover(folder).finally(() => {
			if (this._discoverPromise === pending) {
				this._discoverPromise = undefined;
			}
		});
		this._discoverPromise = pending;
		return pending;
	}

	listAdapters(): readonly IFrameAdapterDescriptor[] {
		return [...this._adapters.values()];
	}

	getAdapter(id: string): IFrameAdapterDescriptor | undefined {
		return this._adapters.get(id);
	}

	async registerAdapter(input: IFrameRegisterAdapterInput): Promise<IFrameAdapterDescriptor> {
		await this.discover();
		const folder = this.primaryFolder();
		if (!folder) {
			throw new Error('No workspace folder open — cannot persist adapter.');
		}

		const now = Date.now();
		const id = sanitizeAdapterId(input.id || input.name || generateUuid());
		const scope = input.scope;
		const language = input.language ?? (scope === FrameAdapterScope.Language ? id : undefined);
		const weightFileName = sanitizeWeightFileName(input.weightFileName || defaultWeightFileName(scope, language ?? id));
		if (!weightFileName) {
			throw new Error('Adapter weight file name is missing or unsafe.');
		}
		const existing = this._adapters.get(id);

		const descriptor: IFrameAdapterDescriptor = {
			id,
			name: input.name,
			kind: input.kind ?? FrameAdapterKind.LoRA,
			state: input.state ?? FrameAdapterState.Available,
			scope,
			baseModelId: input.baseModelId ?? DEFAULT_BASE_MODEL,
			language,
			version: input.version ?? DEFAULT_VERSION,
			trainingExamples: input.trainingExamples ?? 0,
			description: input.description,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			localPath: `.frame/adapters/${id}`,
			weightFileName,
			rank: input.rank,
			tags: mergeScopeTags(scope, language, input.tags),
		};

		await this.writeAdapterToDisk(folder, descriptor);
		const probed = await this.probeWeightOnDisk(folder, descriptor);
		const withProbe: IFrameAdapterDescriptor = {
			...descriptor,
			weightsLinked: probed.weightsLinked,
			weightBytes: probed.weightBytes,
		};
		this._adapters.set(id, withProbe);
		await this.writeRegistryIndex(folder);
		this._onDidChangeAdapters.fire(this.listAdapters());
		this.logService.info(`[FrameAdapters] Registered ${id} (${scope}) under .frame/adapters/`);
		return withProbe;
	}

	async loadMetadata(id: string): Promise<IFrameAdapterMetadata | undefined> {
		await this.discover();
		const folder = this._folder ?? this.primaryFolder();
		if (!folder) {
			return undefined;
		}
		try {
			const buf = await this.fileService.readFile(joinPath(folder, '.frame', 'adapters', id, 'metadata.json'));
			return JSON.parse(buf.value.toString()) as IFrameAdapterMetadata;
		} catch {
			const descriptor = this._adapters.get(id);
			return descriptor ? descriptorToMetadata(descriptor) : undefined;
		}
	}

	async setAdapterState(id: string, state: FrameAdapterState): Promise<IFrameAdapterDescriptor | undefined> {
		await this.discover();
		const existing = this._adapters.get(id);
		if (!existing) {
			return undefined;
		}
		// Foundation LoRA cannot be deactivated — always on.
		if (isFrameBuiltinAdapter(existing) && state !== FrameAdapterState.Active) {
			this.logService.info(`[FrameAdapters] Ignoring deactivate for builtin ${id}`);
			return existing;
		}
		const next: IFrameAdapterDescriptor = { ...existing, state, updatedAt: Date.now() };
		this._adapters.set(id, next);
		const folder = this._folder ?? this.primaryFolder();
		if (folder) {
			await this.writeAdapterToDisk(folder, next);
			await this.writeRegistryIndex(folder);
		}
		this._onDidChangeAdapters.fire(this.listAdapters());
		return next;
	}

	async removeAdapter(id: string): Promise<boolean> {
		await this.discover();
		const existing = this._adapters.get(id);
		if (!existing) {
			return false;
		}
		if (isFrameBuiltinAdapter(existing) || isFrameBuiltinAdapterId(id)) {
			this.logService.warn(`[FrameAdapters] Refusing to remove builtin adapter ${id}`);
			return false;
		}
		this._adapters.delete(id);
		const folder = this._folder ?? this.primaryFolder();
		if (folder) {
			await this.deleteAdapterDir(folder, id);
		}
		this._onDidChangeAdapters.fire(this.listAdapters());
		this.logService.info(`[FrameAdapters] Removed ${id}`);
		return true;
	}

	async unregisterAdapter(id: string): Promise<boolean> {
		return this.removeAdapter(id);
	}

	checkCompatibility(id: string, request: IFrameAdapterCompatibilityRequest): IFrameAdapterCompatibilityResult {
		const adapter = this._adapters.get(id);
		if (!adapter) {
			return { adapterId: id, compatible: false, reasons: ['Adapter not found in registry.'] };
		}

		const reasons: string[] = [];

		if (request.language && adapter.language) {
			if (normalizeLang(adapter.language) !== normalizeLang(request.language)) {
				reasons.push(`Language mismatch: adapter=${adapter.language}, requested=${request.language}`);
			}
		} else if (request.language && adapter.scope === FrameAdapterScope.Language && !adapter.language) {
			reasons.push('Language adapter missing language field.');
		}

		if (request.baseModelId) {
			if (normalizeId(adapter.baseModelId) !== normalizeId(request.baseModelId)
				&& adapter.baseModelId !== DEFAULT_BASE_MODEL
				&& request.baseModelId !== DEFAULT_BASE_MODEL) {
				reasons.push(`Base model mismatch: adapter=${adapter.baseModelId}, requested=${request.baseModelId}`);
			}
		}

		if (request.minAdapterVersion && compareLooseVersion(adapter.version, request.minAdapterVersion) < 0) {
			reasons.push(`Adapter version ${adapter.version} < required ${request.minAdapterVersion}`);
		}

		if (adapter.state === FrameAdapterState.Failed || adapter.state === FrameAdapterState.Disabled) {
			reasons.push(`Adapter state is ${adapter.state}.`);
		}

		return {
			adapterId: id,
			compatible: reasons.length === 0,
			reasons,
		};
	}

	async exportAdapter(id: string): Promise<IFrameAdapterExportPackage | undefined> {
		await this.discover();
		const metadata = await this.loadMetadata(id);
		if (!metadata) {
			return undefined;
		}
		const descriptor = this._adapters.get(id);
		const hasWeights = !!descriptor?.weightsLinked;
		return {
			formatVersion: FRAME_ADAPTER_PACKAGE_VERSION,
			exportedAt: Date.now(),
			metadata,
			weightPlaceholder: descriptor?.weightFileName ?? metadata.weightFile ?? '',
			hasWeights,
		};
	}

	async importAdapter(pkg: IFrameAdapterExportPackage, options?: { activate?: boolean; folder?: URI }): Promise<IFrameAdapterDescriptor> {
		if (!pkg || pkg.formatVersion !== FRAME_ADAPTER_PACKAGE_VERSION) {
			throw new Error(`Unsupported adapter package version: ${pkg?.formatVersion}`);
		}
		const meta = pkg.metadata;
		if (!meta?.name || !meta.scope || !meta.baseModel || !meta.version) {
			throw new Error('Invalid adapter metadata: name, scope, baseModel, and version are required.');
		}
		const validScopes: readonly string[] = [FrameAdapterScope.Language, FrameAdapterScope.Project, FrameAdapterScope.User];
		if (!validScopes.includes(meta.scope)) {
			throw new Error(`Invalid adapter scope: ${meta.scope}`);
		}

		const descriptor = await this.registerAdapter({
			id: meta.id || sanitizeAdapterId(meta.name),
			name: meta.name,
			scope: meta.scope,
			language: meta.language,
			version: meta.version,
			baseModelId: meta.baseModel,
			kind: meta.kind ?? FrameAdapterKind.LoRA,
			state: options?.activate ? FrameAdapterState.Active : (meta.state ?? FrameAdapterState.Available),
			description: meta.description,
			trainingExamples: meta.trainingExamples ?? 0,
			rank: meta.rank,
			tags: meta.tags,
			weightFileName: sanitizeWeightFileName(meta.weightFile),
		});

		// Package JSON carries metadata only; link real weights with importWeightFile.
		void pkg.weightPlaceholder;
		if (options?.folder) {
			this._folder = options.folder;
		}
		return descriptor;
	}

	async importWeightFile(adapterId: string, absoluteSourcePath: string): Promise<IFrameAdapterDescriptor | undefined> {
		await this.discover();
		const existing = this._adapters.get(adapterId);
		if (!existing) {
			this.logService.warn(`[FrameAdapters] importWeightFile: adapter not found: ${adapterId}`);
			return undefined;
		}

		const folder = this._folder ?? this.primaryFolder();
		if (!folder) {
			throw new Error('No workspace folder open — cannot import weights.');
		}

		const trimmed = absoluteSourcePath.trim();
		if (!trimmed) {
			throw new Error('Weight source path is empty.');
		}

		const sourceUri = URI.file(trimmed);
		if (!(await this.fileService.exists(sourceUri))) {
			throw new Error(`Weight file not found: ${trimmed}`);
		}

		const stat = await this.fileService.stat(sourceUri);
		const size = typeof stat.size === 'number' ? stat.size : 0;
		if (size < MIN_WEIGHT_BYTES) {
			throw new Error(`Weight file too small (${size} bytes) — refusing tiny/placeholder files (< ${MIN_WEIGHT_BYTES} B).`);
		}

		const peek = await this.fileService.readFile(sourceUri, { length: 512 });
		if (looksLikeTextPlaceholder(peek.value.toString())) {
			throw new Error('Source looks like a text placeholder, not real LoRA weights.');
		}

		const ext = weightExtension(trimmed);
		if (!ext) {
			throw new Error('Weight file must end in .gguf or .safetensors.');
		}
		if (ext === '.safetensors') {
			this.logService.warn(
				'[FrameAdapters] MLX safetensors may not load in node-llama-cpp — GGUF LoRA preferred. Copied anyway.',
			);
		} else {
			this.logService.info('[FrameAdapters] Importing GGUF LoRA weights (preferred for node-llama-cpp).');
		}

		const weightFileName = sanitizeWeightFileName(weightFileNameFromSource(trimmed, existing.id, ext));
		if (!weightFileName) {
			throw new Error('Refusing unsafe weight file name after sanitization.');
		}
		const root = joinPath(folder, '.frame', 'adapters', existing.id);
		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(joinPath(folder, '.frame', 'adapters'));
		await this.ensureDir(root);
		await this.ensureGitignore(folder);

		const destUri = joinPath(root, weightFileName);
		await this.fileService.copy(sourceUri, destUri, true);

		const next: IFrameAdapterDescriptor = {
			...existing,
			weightFileName,
			localPath: `.frame/adapters/${existing.id}`,
			updatedAt: Date.now(),
		};
		const probed = await this.probeWeightOnDisk(folder, { ...next, weightFileName });
		const linked: IFrameAdapterDescriptor = {
			...next,
			weightsLinked: probed.weightsLinked,
			weightBytes: probed.weightBytes,
		};
		this._adapters.set(existing.id, linked);
		await this.writeAdapterToDisk(folder, linked);
		await this.writeRegistryIndex(folder);
		this._onDidChangeAdapters.fire(this.listAdapters());
		this.logService.info(`[FrameAdapters] Linked weights for ${existing.id} → ${weightFileName} (${size} bytes)`);
		return linked;
	}

	async importWeightAsAdapter(absoluteSourcePath: string, options?: {
		activate?: boolean;
		name?: string;
		scope?: FrameAdapterScope;
	}): Promise<IFrameAdapterDescriptor> {
		const trimmed = absoluteSourcePath.trim();
		if (!trimmed) {
			throw new Error('Weight source path is empty.');
		}
		const ext = weightExtension(trimmed);
		if (!ext) {
			throw new Error('Weight file must end in .gguf or .safetensors.');
		}
		const baseName = trimmed.split(/[/\\]/).pop() || `adapter${ext}`;
		const stem = baseName.replace(/\.(gguf|safetensors)$/i, '');
		const name = (options?.name?.trim() || stem || 'Imported LoRA').slice(0, 80);
		const scope = options?.scope ?? FrameAdapterScope.Project;
		const descriptor = await this.registerAdapter({
			name,
			scope,
			kind: FrameAdapterKind.LoRA,
			state: options?.activate ? FrameAdapterState.Active : FrameAdapterState.Available,
			description: `Imported from ${baseName}`,
			tags: ['imported', 'weight-file'],
			weightFileName: weightFileNameFromSource(trimmed, sanitizeAdapterId(name), ext),
		});
		const linked = await this.importWeightFile(descriptor.id, trimmed);
		if (!linked) {
			throw new Error(`Registered ${descriptor.id} but failed to copy weight file.`);
		}
		return linked;
	}

	async resolveWeightUri(adapterId: string): Promise<URI | undefined> {
		await this.discover();
		const folder = this._folder ?? this.primaryFolder();
		const adapter = this._adapters.get(adapterId);
		if (!folder || !adapter) {
			return undefined;
		}
		const abs = resolveAdapterWeightAbsolutePath(adapter, (...parts) => joinPath(folder, ...parts).fsPath);
		if (!abs) {
			return undefined;
		}
		const uri = URI.file(abs);
		if (!(await this.fileService.exists(uri))) {
			return undefined;
		}
		const probed = await this.probeWeightUri(uri);
		return probed.weightsLinked ? uri : undefined;
	}

	async exportWeightFile(adapterId: string, absoluteDestPath: string): Promise<URI> {
		const source = await this.resolveWeightUri(adapterId);
		if (!source) {
			throw new Error('No real LoRA weight file linked for this adapter. Link or import a .gguf / .safetensors file first.');
		}
		const destTrimmed = absoluteDestPath.trim();
		if (!destTrimmed) {
			throw new Error('Destination path is empty.');
		}
		const destUri = URI.file(destTrimmed);
		await this.fileService.copy(source, destUri, true);
		this.logService.info(`[FrameAdapters] Exported weights ${adapterId} → ${destTrimmed}`);
		return destUri;
	}

	private async doDiscover(folder?: URI): Promise<readonly IFrameAdapterDescriptor[]> {
		const target = folder ?? this.primaryFolder();
		if (!target) {
			this._folder = undefined;
			this.clearAdaptersIfNeeded();
			return this.listAdapters();
		}
		this._folder = target;
		const root = joinPath(target, '.frame', 'adapters');

		const found = new Map<string, IFrameAdapterDescriptor>();
		try {
			const stat = await this.fileService.resolve(root);
			if (stat.isDirectory && stat.children) {
				for (const child of stat.children) {
					if (!child.isDirectory) {
						continue;
					}
					try {
						const metaBuf = await this.fileService.readFile(joinPath(child.resource, 'metadata.json'));
						const meta = JSON.parse(metaBuf.value.toString()) as IFrameAdapterMetadata;
						const descriptor = metadataToDescriptor(meta, child.name);
						const probed = await this.probeWeightOnDisk(target, descriptor);
						found.set(descriptor.id, {
							...descriptor,
							weightsLinked: probed.weightsLinked,
							weightBytes: probed.weightBytes,
						});
					} catch (err) {
						this.logService.trace('[FrameAdapters] skip unreadable adapter dir', child.name, err);
					}
				}
			}
		} catch {
			this.logService.trace('[FrameAdapters] No .frame/adapters/ yet — will seed builtin');
		}

		this._adapters.clear();
		for (const [id, d] of found) {
			this._adapters.set(id, d);
		}

		await this.ensureBuiltinFrameAgentAdapter(target);

		this._onDidChangeAdapters.fire(this.listAdapters());
		this.logService.info(`[FrameAdapters] Discovered ${this._adapters.size} adapter(s)`);
		return this.listAdapters();
	}

	/**
	 * Product foundation LoRA: always present + active under `.frame/adapters/frame-agent-v1/`.
	 * Copies shipped GGUF when available; otherwise metadata-only until convert lands.
	 */
	private async ensureBuiltinFrameAgentAdapter(folder: URI): Promise<void> {
		const now = Date.now();
		const existing = this._adapters.get(FRAME_BUILTIN_ADAPTER_ID);
		const shippedUri = await this.resolveShippedBuiltinWeightUri();
		const base = createBuiltinFrameAgentDescriptor(existing?.createdAt ?? now);
		// Only claim a weightFile when a real shipped LoRA GGUF exists.
		// v1 ships fused into the base modelPath — no separate adapters.gguf.
		const weightFileName = shippedUri
			? FRAME_BUILTIN_WEIGHT_BASENAME
			: sanitizeWeightFileName(existing?.weightFileName);

		const fusedIntoBase = !shippedUri && (existing?.tags?.includes('fused-into-base') || true);
		const description = shippedUri
			? base.description
			: 'Built-in Frame agent behavior — fused into the default Q4_K_M GGUF. Always on via runtime modelPath.';

		const descriptor: IFrameAdapterDescriptor = {
			...base,
			...existing,
			id: FRAME_BUILTIN_ADAPTER_ID,
			name: base.name,
			kind: base.kind,
			scope: base.scope,
			baseModelId: base.baseModelId,
			language: base.language,
			version: base.version,
			description,
			rank: base.rank,
			tags: mergeUniqueTags([
				...(existing?.tags ?? []),
				...(base.tags ?? []),
				...(fusedIntoBase && !shippedUri ? ['fused-into-base'] : []),
			]),
			builtin: true,
			state: FrameAdapterState.Active,
			localPath: `.frame/adapters/${FRAME_BUILTIN_ADAPTER_ID}`,
			weightFileName,
			updatedAt: now,
			createdAt: existing?.createdAt ?? now,
		};

		await this.writeAdapterToDisk(folder, descriptor);

		if (shippedUri) {
			const dest = joinPath(folder, '.frame', 'adapters', FRAME_BUILTIN_ADAPTER_ID, FRAME_BUILTIN_WEIGHT_BASENAME);
			try {
				const needCopy = !(await this.fileService.exists(dest))
					|| await this.isSourceNewer(shippedUri, dest);
				if (needCopy) {
					await this.fileService.copy(shippedUri, dest, true);
					this.logService.info(`[FrameAdapters] Seeded builtin weights from ${shippedUri.fsPath}`);
				}
			} catch (err) {
				this.logService.warn(`[FrameAdapters] Builtin weight seed failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		const probed = await this.probeWeightOnDisk(folder, descriptor);
		const withProbe: IFrameAdapterDescriptor = {
			...descriptor,
			weightsLinked: probed.weightsLinked,
			weightBytes: probed.weightBytes,
		};
		this._adapters.set(FRAME_BUILTIN_ADAPTER_ID, withProbe);
		await this.writeRegistryIndex(folder);
	}

	private async resolveShippedBuiltinWeightUri(): Promise<URI | undefined> {
		for (const candidate of getFrameBuiltinAdapterWeightCandidates()) {
			const uri = URI.file(candidate);
			try {
				if (await this.fileService.exists(uri)) {
					const st = await this.fileService.stat(uri);
					if (typeof st.size === 'number' && st.size >= MIN_WEIGHT_BYTES) {
						return uri;
					}
				}
			} catch {
				// try next
			}
		}
		return undefined;
	}

	private async isSourceNewer(source: URI, dest: URI): Promise<boolean> {
		try {
			const [s, d] = await Promise.all([this.fileService.stat(source), this.fileService.stat(dest)]);
			const sm = typeof s.mtime === 'number' ? s.mtime : 0;
			const dm = typeof d.mtime === 'number' ? d.mtime : 0;
			const ss = typeof s.size === 'number' ? s.size : 0;
			const ds = typeof d.size === 'number' ? d.size : 0;
			return sm > dm || ss !== ds;
		} catch {
			return true;
		}
	}

	private async writeAdapterToDisk(folder: URI, descriptor: IFrameAdapterDescriptor): Promise<void> {
		const root = joinPath(folder, '.frame', 'adapters', descriptor.id);
		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(joinPath(folder, '.frame', 'adapters'));
		await this.ensureDir(root);
		await this.ensureGitignore(folder);

		const metadata = descriptorToMetadata(descriptor);
		await this.fileService.writeFile(
			joinPath(root, 'metadata.json'),
			VSBuffer.fromString(JSON.stringify(metadata, null, 2) + '\n'),
		);

		const weightsMd = joinPath(root, 'WEIGHTS.md');
		if (!(await this.fileService.exists(weightsMd))) {
			await this.fileService.writeFile(weightsMd, VSBuffer.fromString(WEIGHTS_MD));
		}
	}

	private async writeRegistryIndex(folder: URI): Promise<void> {
		const index = {
			version: FRAME_ADAPTER_PACKAGE_VERSION,
			updatedAt: Date.now(),
			adapters: this.listAdapters().map(a => ({
				id: a.id,
				name: a.name,
				scope: a.scope,
				language: a.language,
				state: a.state,
				version: a.version,
				baseModelId: a.baseModelId,
			})),
		};
		await this.fileService.writeFile(
			joinPath(folder, '.frame', 'adapters', 'registry.json'),
			VSBuffer.fromString(JSON.stringify(index, null, 2) + '\n'),
		);
	}

	private async deleteAdapterDir(folder: URI, id: string): Promise<void> {
		const root = joinPath(folder, '.frame', 'adapters', id);
		try {
			await this.fileService.del(root, { recursive: true, useTrash: false });
		} catch (err) {
			this.logService.trace('[FrameAdapters] delete failed', id, err);
		}
		await this.writeRegistryIndex(folder);
	}

	private clearAdaptersIfNeeded(): void {
		if (!this._adapters.size) {
			return;
		}
		this._adapters.clear();
		this._onDidChangeAdapters.fire(this.listAdapters());
	}

	private primaryFolder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}

	private async ensureDir(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// exists
		}
	}

	private async ensureGitignore(folder: URI): Promise<void> {
		const gi = joinPath(folder, '.frame', '.gitignore');
		try {
			if (!(await this.fileService.exists(gi))) {
				await this.fileService.writeFile(gi, VSBuffer.fromString('*\n'));
			}
		} catch {
			// ignore
		}
	}

	private async probeWeightOnDisk(
		folder: URI,
		adapter: Pick<IFrameAdapterDescriptor, 'id' | 'localPath' | 'weightFileName'>,
	): Promise<{ weightsLinked: boolean; weightBytes?: number }> {
		const abs = resolveAdapterWeightAbsolutePath(adapter, (...parts) => joinPath(folder, ...parts).fsPath);
		if (!abs) {
			return { weightsLinked: false };
		}
		return this.probeWeightUri(URI.file(abs));
	}

	private async probeWeightUri(uri: URI): Promise<{ weightsLinked: boolean; weightBytes?: number }> {
		try {
			if (!(await this.fileService.exists(uri))) {
				return { weightsLinked: false };
			}
			const stat = await this.fileService.stat(uri);
			const size = typeof stat.size === 'number' ? stat.size : 0;
			if (size < MIN_WEIGHT_BYTES) {
				return { weightsLinked: false, weightBytes: size };
			}
			const peek = await this.fileService.readFile(uri, { length: 512 });
			if (looksLikeTextPlaceholder(peek.value.toString())) {
				return { weightsLinked: false, weightBytes: size };
			}
			return { weightsLinked: true, weightBytes: size };
		} catch {
			return { weightsLinked: false };
		}
	}
}

function descriptorToMetadata(d: IFrameAdapterDescriptor): IFrameAdapterMetadata {
	return {
		id: d.id,
		name: d.name,
		language: d.language,
		version: d.version,
		baseModel: d.baseModelId,
		created: d.createdAt,
		trainingExamples: d.trainingExamples,
		lastUpdated: d.updatedAt,
		scope: d.scope,
		kind: d.kind,
		state: d.state,
		description: d.description,
		weightFile: d.weightFileName,
		rank: d.rank,
		tags: d.tags,
		builtin: d.builtin || isFrameBuiltinAdapterId(d.id) || undefined,
	};
}

function metadataToDescriptor(meta: IFrameAdapterMetadata, folderName: string): IFrameAdapterDescriptor {
	const id = sanitizeAdapterId(meta.id || folderName);
	const builtin = !!meta.builtin || isFrameBuiltinAdapterId(id);
	return {
		id,
		name: meta.name || id,
		kind: meta.kind ?? FrameAdapterKind.LoRA,
		state: builtin ? FrameAdapterState.Active : (meta.state ?? FrameAdapterState.Available),
		scope: meta.scope ?? FrameAdapterScope.Language,
		baseModelId: meta.baseModel || DEFAULT_BASE_MODEL,
		language: meta.language,
		version: meta.version || DEFAULT_VERSION,
		trainingExamples: meta.trainingExamples ?? 0,
		description: meta.description,
		createdAt: meta.created || Date.now(),
		updatedAt: meta.lastUpdated || meta.created || Date.now(),
		localPath: `.frame/adapters/${id}`,
		weightFileName: sanitizeWeightFileName(meta.weightFile),
		rank: meta.rank,
		tags: meta.tags,
		builtin: builtin || undefined,
	};
}

/** Basename-only; blocks `../` escapes into the worker via adapterPaths. */
function sanitizeWeightFileName(name: string | undefined): string | undefined {
	if (typeof name !== 'string' || !name.trim()) {
		return undefined;
	}
	const base = name.trim().replace(/\\/g, '/').split('/').pop() ?? '';
	if (!base || base === '.' || base === '..' || base.includes('\0') || base.includes('..')) {
		return undefined;
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(base)) {
		return undefined;
	}
	if (!/\.(gguf|safetensors)$/i.test(base)) {
		return undefined;
	}
	return base.slice(0, 120);
}

function defaultWeightFileName(_scope: FrameAdapterScope, key: string): string {
	return `LoRA.${sanitizeAdapterId(key)}.gguf`;
}

function weightExtension(absolutePath: string): '.gguf' | '.safetensors' | undefined {
	const lower = absolutePath.toLowerCase();
	if (lower.endsWith('.gguf')) {
		return '.gguf';
	}
	if (lower.endsWith('.safetensors')) {
		return '.safetensors';
	}
	return undefined;
}

function weightFileNameFromSource(absolutePath: string, adapterId: string, ext: '.gguf' | '.safetensors'): string {
	const base = absolutePath.split(/[/\\]/).pop() || '';
	const sanitized = base
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (sanitized.toLowerCase().endsWith(ext)) {
		return sanitized.slice(0, 120);
	}
	return `LoRA.${sanitizeAdapterId(adapterId)}${ext}`;
}

function looksLikeTextPlaceholder(sample: string): boolean {
	const head = sample.slice(0, 256).trimStart();
	if (!head) {
		return false;
	}
	if (/^#\s*Frame LoRA placeholder/i.test(head)) {
		return true;
	}
	if (/placeholder/i.test(head) && /lora|weight|training deferred/i.test(head)) {
		return true;
	}
	// Mostly printable ASCII / newlines → likely a text stub, not binary weights.
	let printable = 0;
	const limit = Math.min(sample.length, 256);
	for (let i = 0; i < limit; i++) {
		const c = sample.charCodeAt(i);
		if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) {
			printable++;
		}
	}
	return limit > 0 && printable / limit > 0.95 && /^(#|\/\/|\{|\[|<)/.test(head);
}

function sanitizeAdapterId(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80) || generateUuid();
}

function mergeUniqueTags(tags: readonly string[]): string[] {
	const set = new Set<string>();
	for (const t of tags) {
		const v = String(t || '').trim();
		if (v) {
			set.add(v);
		}
	}
	return [...set];
}

function mergeScopeTags(scope: FrameAdapterScope, language: string | undefined, tags?: readonly string[]): string[] {
	const set = new Set<string>([scope, ...(tags ?? [])]);
	if (language) {
		set.add(language.toLowerCase());
		set.add(`lang:${language.toLowerCase()}`);
	}
	if (scope === FrameAdapterScope.Language) {
		set.add('language');
	}
	if (scope === FrameAdapterScope.User) {
		set.add('user');
		set.add('style');
	}
	if (scope === FrameAdapterScope.Project) {
		set.add('project');
	}
	return [...set];
}

function normalizeLang(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeId(s: string): string {
	return s.toLowerCase().trim();
}

/** Very loose semver compare: "1.2.3" style; non-numeric → string compare. */
function compareLooseVersion(a: string, b: string): number {
	const pa = a.split('.').map(x => Number.parseInt(x, 10));
	const pb = b.split('.').map(x => Number.parseInt(x, 10));
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const na = Number.isFinite(pa[i]) ? pa[i] : 0;
		const nb = Number.isFinite(pb[i]) ? pb[i] : 0;
		if (na !== nb) {
			return na < nb ? -1 : 1;
		}
	}
	return 0;
}
