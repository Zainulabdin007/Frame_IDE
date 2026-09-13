/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import {
	FrameModelTrustStatus,
	FrameRuntimeKind,
	IFrameGenerateOptions,
	IFrameInferenceContext,
	IFrameInferenceResult,
	IFrameModelDescriptor,
	IFrameRuntimeConfig,
	IFrameRuntimeDescriptor,
	IFrameRuntimeStatus,
} from '../common/models.js';
import { IFrameModelService } from '../models/frameModels.js';
import { FRAME_PACKAGE_CHECKSUM_PLACEHOLDER } from '../models/frameModelPackage.js';
import { IFrameInferenceRuntime } from './frameInferenceRuntime.js';
import { FrameLlamaCppRuntimePlaceholder } from './frameLlamaCppRuntimePlaceholder.js';
import { FrameLocalInferenceRuntime } from './frameLocalInferenceRuntime.js';
import { FrameMlxRuntimePlaceholder } from './frameMlxRuntimePlaceholder.js';
import { buildRuntimeAdapters, withResolvedAdapterPaths, IFrameRuntimeAdapters } from './frameAdapterRuntime.js';
import { IFrameModelExecutor } from './frameModelExecution.js';
import { IFrameRuntimeService } from './frameRuntime.js';
import { IFrameModelWorkerManager } from './worker/frameModelWorkerManager.js';
import { IFrameToolExecutionService } from './tools/frameToolExecutionService.js';
import {
	FRAME_BUILTIN_ADAPTER_ID,
	FRAME_BUILTIN_ADAPTER_METADATA_BASENAME,
	FRAME_BUILTIN_BASE_MODEL,
	FRAME_BUILTIN_WEIGHT_BASENAME,
	frameModelPathLooksFused,
	getFrameBundledBaseModelCandidates,
	getFrameBuiltinAdapterWeightCandidates,
	mergeBuiltinAdapterPaths,
} from '../adapters/frameBuiltinAdapters.js';

const CONFIG_REL = '.frame/config/runtime.json';
const DEFAULT_CONFIG: IFrameRuntimeConfig = {
	runtime: 'stub',
	activeModelId: null,
	modelPath: null,
	enabled: false,
	allowUnverifiedModels: false,
};

/**
 * Registers local backends, persists `.frame/config/runtime.json`, selects active runtime.
 * Owns the tool-calling round-trip bridge (worker toolRequest → IDE execute → toolResult).
 * Never downloads models or opens cloud sockets.
 */
export class FrameRuntimeService extends Disposable implements IFrameRuntimeService {

	declare readonly _serviceBrand: undefined;

	private readonly _runtimes = new Map<string, IFrameInferenceRuntime>();
	private _activeId = 'stub';
	private _config: IFrameRuntimeConfig = { ...DEFAULT_CONFIG };
	private readonly _tokenListeners = this._register(new DisposableStore());

	private readonly _onDidChangeStatus = this._register(new Emitter<IFrameRuntimeStatus>());
	readonly onDidChangeStatus: Event<IFrameRuntimeStatus> = this._onDidChangeStatus.event;

	private readonly _onDidStreamToken = this._register(new Emitter<{ readonly taskId: string; readonly token: string }>());
	/** Relayed stream from the active runtime (for orchestrator / UI). */
	readonly onDidStreamToken: Event<{ readonly taskId: string; readonly token: string }> = this._onDidStreamToken.event;

	private _initPromise: Promise<void> | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IPathService private readonly pathService: IPathService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFrameModelService private readonly modelService: IFrameModelService,
		@IFrameModelWorkerManager private readonly workerManager: IFrameModelWorkerManager,
		@IFrameModelExecutor private readonly modelExecutor: IFrameModelExecutor,
		@IFrameToolExecutionService private readonly toolExecution: IFrameToolExecutionService,
	) {
		super();
		const stub = this.instantiationService.createInstance(FrameLocalInferenceRuntime);
		const mlx = this.instantiationService.createInstance(FrameMlxRuntimePlaceholder);
		const llama = this.instantiationService.createInstance(FrameLlamaCppRuntimePlaceholder);
		this.registerRuntime(stub);
		this.registerRuntime(mlx);
		this.registerRuntime(llama);
		this._register(this.modelService.onDidChangeModels(() => {
			void this.syncActiveModelFromRegistry();
			this._onDidChangeStatus.fire(this.getStatus());
		}));
		this._register(this.workerManager.onDidChangeHealth(() => {
			this._onDidChangeStatus.fire(this.getStatus());
		}));
		this._register(this.workerManager.onDidStream(e => {
			if (e.kind === 'token' && e.token) {
				this._onDidStreamToken.fire({
					taskId: e.taskId ?? e.requestId,
					token: e.token,
				});
			}
			this._onDidChangeStatus.fire(this.getStatus());
		}));
		this._register(this.workerManager.onDidToolRequest(req => {
			void this.handleToolRequest(req);
		}));
		this._register(this.toolExecution.onDidChangeActivity(() => {
			this._onDidChangeStatus.fire(this.getStatus());
		}));
		// Workspace may restore after first init (empty window → folder). Reload config then.
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			void this.reloadConfigFromDisk('workspace-folders-changed');
		}));
		void this.initialize();
	}

	private async handleToolRequest(req: {
		readonly requestId: string;
		readonly callId: string;
		readonly tool: string;
		readonly args?: Readonly<Record<string, unknown>>;
	}): Promise<void> {
		this.logService.info(`[FrameRuntime] toolRequest ${req.tool} callId=${req.callId}`);
		try {
			const result = await this.toolExecution.executeWorkerRequest({
				requestId: req.requestId,
				callId: req.callId,
				tool: req.tool,
				args: req.args,
				conversationId: this.workerManager.getDiagnostics().activeConversationId,
				workerId: this.workerManager.health().workerId,
			});
			this.workerManager.postToolResult({
				type: 'toolResult',
				requestId: result.requestId,
				callId: result.callId,
				success: result.success,
				data: result.data,
				error: result.error,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logService.error(`[FrameRuntime] toolRequest failed: ${message}`);
			this.workerManager.postToolResult({
				type: 'toolResult',
				requestId: req.requestId,
				callId: req.callId,
				success: false,
				error: message,
			});
		}
	}

	registerRuntime(runtime: IFrameInferenceRuntime): void {
		this._runtimes.set(runtime.id, runtime);
		this.rebindingStreamRelay();
		this._onDidChangeStatus.fire(this.getStatus());
		this.logService.info(`[FrameRuntime] Registered backend: ${runtime.id} (${runtime.displayName})`);
	}

	listRuntimes(): readonly IFrameRuntimeDescriptor[] {
		return [...this._runtimes.values()].map(r => this.toDescriptor(r));
	}

	getRuntime(id: string): IFrameInferenceRuntime | undefined {
		return this._runtimes.get(id);
	}

	getActiveRuntime(): IFrameInferenceRuntime {
		const active = this._runtimes.get(this._activeId);
		if (active) {
			return active;
		}
		const stub = this._runtimes.get('stub');
		if (!stub) {
			throw new Error('Frame stub runtime missing from registry.');
		}
		return stub;
	}

	async selectRuntime(id: string): Promise<void> {
		const runtime = this._runtimes.get(id);
		if (!runtime) {
			throw new Error(`Unknown runtime: ${id}`);
		}
		await this.updateConfig({ runtime: runtime.kind });
	}

	isAvailable(id: string): boolean {
		return this._runtimes.get(id)?.isAvailable() ?? false;
	}

	getStatus(): IFrameRuntimeStatus {
		const active = this.getActiveRuntime();
		const selected = this.getSelectedModelMetadata();
		const worker = this.workerManager.getSnapshot();
		return {
			activeRuntimeId: active.id,
			activeKind: active.kind,
			enabled: this._config.enabled,
			activeModelId: this._config.activeModelId ?? selected?.id ?? null,
			modelPath: this.resolveEffectiveModelPath(selected),
			available: this.listRuntimes(),
			configPath: CONFIG_REL,
			selectedModel: selected,
			worker,
			execution: this.modelExecutor.getExecutionView(),
		};
	}

	getConfig(): IFrameRuntimeConfig {
		return { ...this._config };
	}

	getSelectedModelMetadata(): IFrameModelDescriptor | undefined {
		const id = this._config.activeModelId;
		if (id) {
			return this.modelService.getModel(id) ?? this.modelService.getActiveModel();
		}
		return this.modelService.getActiveModel();
	}

	async updateConfig(patch: Partial<IFrameRuntimeConfig>): Promise<IFrameRuntimeConfig> {
		this._config = {
			...this._config,
			...patch,
			updatedAt: Date.now(),
		};
		if (patch.activeModelId !== undefined && patch.activeModelId) {
			await this.modelService.selectActiveModel(patch.activeModelId);
		}
		await this.persistConfig();
		await this.applyConfig();
		this._onDidChangeStatus.fire(this.getStatus());
		return this.getConfig();
	}

	async initialize(): Promise<void> {
		if (!this._initPromise) {
			this._initPromise = this.doInitialize();
		}
		return this._initPromise;
	}

	async generate(context: IFrameInferenceContext, options?: IFrameGenerateOptions): Promise<IFrameInferenceResult> {
		await this.initialize();
		// Recover from empty-window init: re-read disk if we still have no GGUF path.
		if (!this.resolveEffectiveModelPath(this.getSelectedModelMetadata())) {
			await this.reloadConfigFromDisk('generate-missing-modelPath');
		}
		const runtime = this.resolveRuntimeForGenerate();
		if (!runtime.isReady()) {
			await runtime.initialize();
		}
		const selected = this.getSelectedModelMetadata();
		const modelPath = this.resolveEffectiveModelPath(selected);
		if (!this._config.enabled || runtime.id === 'stub' || !modelPath) {
			this.logService.info(
				`[FrameRuntime] generate via ${runtime.id} fallback — enabled=${this._config.enabled} modelPath=${modelPath ?? '(null)'}`,
			);
			return runtime.generate(context, options);
		}
		const trustBlock = this.trustBlocksModelLoad(selected);
		if (trustBlock) {
			throw new Error(trustBlock);
		}
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		let adapters = folder
			? withResolvedAdapterPaths(
				selected?.id ?? this._config.activeModelId ?? 'none',
				context.adapters.active,
				context.adapters,
				(...parts) => joinPath(folder, ...parts).fsPath,
			)
			: buildRuntimeAdapters(
				selected?.id ?? this._config.activeModelId ?? 'none',
				context.adapters.active,
				context.adapters,
			);
		adapters = await this.withBuiltinFoundationAdapter(adapters, folder, modelPath);
		this.logService.info(
			`[FrameRuntime] generate via executor → worker — backend=${runtime.id} model=${selected?.id ?? '(none)'} modelPath=${modelPath ?? '(null)'} adapters=${adapters.languageAdapters.length + adapters.projectAdapters.length + adapters.userAdapters.length} weightPaths=${adapters.adapterPaths?.length ?? 0}`,
		);
		// initialize is idempotent (skips reload when modelPath unchanged)
		await this.modelExecutor.initialize({
			modelId: selected?.id ?? this._config.activeModelId ?? 'none',
			modelPath,
			displayName: selected?.displayName,
			adapters,
			runtimeId: runtime.id,
		});
		return this.modelExecutor.generate(context, options);
	}

	/** Re-read runtime.json (workspace and/or ~/.frame) and re-apply. */
	private async reloadConfigFromDisk(reason: string): Promise<void> {
		this.logService.info(`[FrameRuntime] Reloading config (${reason})`);
		await this.loadConfig();
		if (this._config.activeModelId) {
			await this.modelService.selectActiveModel(this._config.activeModelId);
			if (this._config.modelPath) {
				await this.modelService.setModelLocalPath(this._config.activeModelId, this._config.modelPath);
			}
		} else {
			await this.syncActiveModelFromRegistry();
		}
		await this.applyConfig();
		this._onDidChangeStatus.fire(this.getStatus());
		this.logService.info(
			`[FrameRuntime] Config reloaded — active=${this._activeId} enabled=${this._config.enabled} modelPath=${this._config.modelPath ?? '(null)'}`,
		);
	}

	private async doInitialize(): Promise<void> {
		await this.loadConfig();
		// Dev default: always prefer Efficient Q4 when nothing else is selected.
		if (!this._config.activeModelId) {
			this._config = {
				...this._config,
				activeModelId: 'qwen-coder-7b-q4',
				runtime: this._config.runtime === 'stub' ? 'llamacpp' : this._config.runtime,
				enabled: this._config.modelPath ? true : this._config.enabled,
			};
		}
		let discoveredBundled = false;
		if (!this._config.modelPath || !(await this.fileExists(this._config.modelPath))) {
			const bundled = await this.resolveBundledBaseModelPath();
			if (bundled) {
				this._config = {
					...this._config,
					modelPath: bundled,
					runtime: 'llamacpp',
					enabled: true,
					activeModelId: this._config.activeModelId ?? FRAME_BUILTIN_BASE_MODEL,
				};
				discoveredBundled = true;
				this.logService.info(`[FrameRuntime] Using bundled Efficient model at ${bundled}`);
			}
		}
		await this.ensureConfigFile();
		if (discoveredBundled) {
			// Persist so empty-window / later sessions keep the same GGUF without re-picking.
			await this.persistConfig();
		}
		const activeId = this._config.activeModelId ?? 'qwen-coder-7b-q4';
		await this.modelService.selectActiveModel(activeId);
		if (this._config.modelPath) {
			await this.modelService.setModelLocalPath(activeId, this._config.modelPath);
		}
		await this.applyConfig();
		await this.getActiveRuntime().initialize();
		// Ensure isolated worker boundary is up (lifecycle only — no weight load).
		await this.workerManager.start();
		this.rebindingStreamRelay();
		// Eager-load GGUF so the first chat turn does not pay cold-start alone.
		if (this._config.enabled && this._config.modelPath) {
			const selected = this.getSelectedModelMetadata();
			const trustBlock = this.trustBlocksModelLoad(selected);
			if (trustBlock) {
				this.logService.warn(`[FrameRuntime] Eager model load skipped: ${trustBlock}`);
			} else {
				try {
					const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
					const adapters = await this.withBuiltinFoundationAdapter(
						buildRuntimeAdapters(activeId, []),
						folder,
						this._config.modelPath,
					);
					await this.modelExecutor.initialize({
						modelId: activeId,
						modelPath: this._config.modelPath,
						displayName: selected?.displayName,
						runtimeId: this._activeId,
						adapters,
					});
					this.logService.info(`[FrameRuntime] Eager model load complete for ${activeId} builtinPaths=${adapters.adapterPaths?.length ?? 0}`);
				} catch (err) {
					this.logService.warn(`[FrameRuntime] Eager model load failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}
		this._onDidChangeStatus.fire(this.getStatus());
		this.logService.info(`[FrameRuntime] Ready — active=${this._activeId} model=${this._config.activeModelId ?? '(none)'} enabled=${this._config.enabled} modelPath=${this._config.modelPath ?? '(null)'} worker=${this.workerManager.health().status}`);
	}

	private resolveRuntimeForGenerate(): IFrameInferenceRuntime {
		// Keep llama path in sync before availability checks.
		const selected = this.getSelectedModelMetadata();
		const effectivePath = this.resolveEffectiveModelPath(selected);
		const llama = this._runtimes.get('llamacpp');
		if (llama instanceof FrameLlamaCppRuntimePlaceholder) {
			llama.setModelPath(effectivePath);
		}

		const preferred = this._runtimes.get(this._activeId) ?? this.getActiveRuntime();
		if (this._config.enabled && preferred.id !== 'stub' && preferred.isAvailable()) {
			return preferred;
		}
		if (this._config.enabled && llama && llama.isAvailable()) {
			if (preferred.id !== llama.id) {
				this.logService.info(`[FrameRuntime] Using llamacpp (path configured; active was ${preferred.id})`);
			}
			return llama;
		}
		const stub = this._runtimes.get('stub');
		if (stub) {
			this.logService.info(`[FrameRuntime] Using stub (enabled=${this._config.enabled} path=${effectivePath ? 'set' : 'none'} preferred=${preferred.id})`);
			return stub;
		}
		return preferred;
	}

	/**
	 * Merge shipped foundation LoRA GGUF into worker adapterPaths when present —
	 * unless the base GGUF already has the adapter fused in, in which case merging
	 * the separate adapters.gguf would apply the LoRA twice.
	 */
	private async withBuiltinFoundationAdapter(
		adapters: IFrameRuntimeAdapters,
		folder: URI | undefined,
		modelPath: string | null,
	): Promise<IFrameRuntimeAdapters> {
		if (await this.isFusedBuiltinBaseModel(modelPath, folder)) {
			this.logService.info(`[FrameRuntime] Builtin adapter is fused into the base model (${modelPath}) — skipping separate ${FRAME_BUILTIN_WEIGHT_BASENAME} merge.`);
			return adapters;
		}
		const abs = await this.resolveBuiltinGgufAbsolutePath(folder);
		if (!abs) {
			return adapters;
		}
		return mergeBuiltinAdapterPaths(adapters, abs);
	}

	/**
	 * Detect the fused builtin base GGUF (installed by install_fused_base_model.py).
	 * Primary signal: adapter metadata.json records `fusedModelPath` matching the
	 * effective modelPath. Fallback: 'fused' in the modelPath basename (the hardlinked
	 * resources/ copy shares the name but not the metadata path) — logged as a warning
	 * because it is only a heuristic.
	 */
	private async isFusedBuiltinBaseModel(modelPath: string | null, folder: URI | undefined): Promise<boolean> {
		if (!modelPath) {
			return false;
		}
		if (folder) {
			try {
				const metaUri = joinPath(folder, '.frame', 'adapters', FRAME_BUILTIN_ADAPTER_ID, FRAME_BUILTIN_ADAPTER_METADATA_BASENAME);
				if (await this.fileService.exists(metaUri)) {
					const buf = await this.fileService.readFile(metaUri);
					const meta = JSON.parse(buf.value.toString()) as { fusedModelPath?: unknown };
					const fusedModelPath = typeof meta.fusedModelPath === 'string' ? meta.fusedModelPath : undefined;
					if (fusedModelPath && normalizeSeparators(fusedModelPath) === normalizeSeparators(modelPath)) {
						return true;
					}
				}
			} catch {
				// unreadable / invalid metadata — fall through to the filename heuristic
			}
		}
		if (frameModelPathLooksFused(modelPath)) {
			this.logService.warn(`[FrameRuntime] modelPath basename contains 'fused' (${modelPath}) — treating builtin adapter as fused into the base GGUF (no fusedModelPath metadata matched).`);
			return true;
		}
		return false;
	}

	private async resolveBuiltinGgufAbsolutePath(folder: URI | undefined): Promise<string | undefined> {
		const candidates: URI[] = [];
		if (folder) {
			candidates.push(joinPath(folder, '.frame', 'adapters', FRAME_BUILTIN_ADAPTER_ID, FRAME_BUILTIN_WEIGHT_BASENAME));
		}
		for (const p of getFrameBuiltinAdapterWeightCandidates()) {
			candidates.push(URI.file(p));
		}
		for (const uri of candidates) {
			try {
				if (!(await this.fileService.exists(uri))) {
					continue;
				}
				const st = await this.fileService.stat(uri);
				if (typeof st.size === 'number' && st.size >= 1024) {
					return uri.fsPath;
				}
			} catch {
				// try next
			}
		}
		return undefined;
	}

	private async applyConfig(): Promise<void> {
		const kind = normalizeRuntimeKind(this._config.runtime);
		const selected = this.getSelectedModelMetadata();
		const effectivePath = this.resolveEffectiveModelPath(selected);
		const mlx = this._runtimes.get('mlx');
		const llama = this._runtimes.get('llamacpp');
		if (mlx instanceof FrameMlxRuntimePlaceholder) {
			mlx.setModelPath(effectivePath);
		}
		if (llama instanceof FrameLlamaCppRuntimePlaceholder) {
			llama.setModelPath(effectivePath);
		}

		const candidate = [...this._runtimes.values()].find(r => r.id === String(this._config.runtime) || r.kind === kind);

		if (this._config.enabled && candidate?.isAvailable()) {
			this._activeId = candidate.id;
		} else if (this._config.enabled && candidate) {
			this._activeId = candidate.id;
		} else {
			this._activeId = 'stub';
		}

		this.rebindingStreamRelay();
	}

	private async syncActiveModelFromRegistry(): Promise<void> {
		const active = this.modelService.getActiveModel();
		const nextId = active?.id ?? null;
		const registryGguf = isGgufPath(active?.localPath) ? active!.localPath : null;
		const configGguf = isGgufPath(this._config.modelPath) ? this._config.modelPath : null;
		// Keep an explicit runtime.json modelPath (e.g. fused Frame-agent) over a stale registry path.
		const nextGguf = configGguf ?? registryGguf;
		const shouldClearPath = !!nextId && !active?.localPath && !configGguf;
		if (nextId === this._config.activeModelId
			&& nextGguf === (isGgufPath(this._config.modelPath) ? this._config.modelPath : null)
			&& !(shouldClearPath && this._config.modelPath)) {
			return;
		}
		this._config = {
			...this._config,
			activeModelId: nextId,
			modelPath: nextGguf ?? (shouldClearPath ? null : (isGgufPath(this._config.modelPath) ? this._config.modelPath : null)),
			updatedAt: Date.now(),
		};
		await this.persistConfig();
		await this.applyConfig();
	}

	private resolveEffectiveModelPath(selected: IFrameModelDescriptor | undefined): string | null {
		// Prefer runtime.json modelPath (product / user override, e.g. fused Frame-agent GGUF).
		// Registry localPath is a fallback for catalog-imported packages.
		if (isGgufPath(this._config.modelPath)) {
			return this._config.modelPath;
		}
		if (isGgufPath(selected?.localPath)) {
			return selected!.localPath;
		}
		const envPath = typeof process !== 'undefined' ? process.env?.FRAME_MODEL_PATH : undefined;
		if (isGgufPath(envPath)) {
			return envPath!;
		}
		return null;
	}

	/**
	 * Block INVALID always. Block UNVERIFIED imported packages unless allowUnverifiedModels.
	 * Catalog / path-only models with no real package trust metadata are allowed.
	 * Placeholder checksums (`sha256:pending-user-weights`) do not count as package trust meta.
	 * Trust status is compared case-insensitively (legacy registries may use lowercase).
	 */
	private trustBlocksModelLoad(selected: IFrameModelDescriptor | undefined): string | undefined {
		const trustRaw = selected?.trustStatus;
		if (!trustRaw) {
			return undefined;
		}
		const trust = String(trustRaw).toUpperCase();
		if (trust === FrameModelTrustStatus.Invalid) {
			return `Refusing to load model "${selected?.id}" — trustStatus is INVALID. Re-import or fix checksums/signature.`;
		}
		const checksum = selected?.checksum;
		const realChecksum = typeof checksum === 'string'
			&& checksum.length > 0
			&& checksum.toLowerCase() !== FRAME_PACKAGE_CHECKSUM_PLACEHOLDER.toLowerCase();
		const hasPackageTrustMeta = !!(realChecksum || selected?.signature);
		if (
			trust === FrameModelTrustStatus.Unverified
			&& hasPackageTrustMeta
			&& !this._config.allowUnverifiedModels
		) {
			return `Refusing to load UNVERIFIED package model "${selected?.id}". Set "allowUnverifiedModels": true in .frame/config/runtime.json after reviewing the package, or import a checksum/signature-valid package.`;
		}
		return undefined;
	}

	private rebindingStreamRelay(): void {
		this._tokenListeners.clear();
		for (const runtime of this._runtimes.values()) {
			this._tokenListeners.add(runtime.onDidStreamToken(e => {
				if (runtime.id === this.resolveRuntimeForGenerate().id || runtime.id === this._activeId) {
					this._onDidStreamToken.fire(e);
				}
			}));
		}
	}

	private toDescriptor(r: IFrameInferenceRuntime): IFrameRuntimeDescriptor {
		return {
			id: r.id,
			kind: r.kind,
			displayName: r.displayName,
			available: r.isAvailable(),
			ready: r.isReady(),
			description: describeRuntime(r.kind),
		};
	}

	private primaryFolder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}

	private configUri(): URI | undefined {
		return this.configCandidateUris()[0];
	}

	/** Workspace `.frame/config` first, then user-home `.frame` / `.frame-dev` (no-folder windows). */
	private configCandidateUris(): URI[] {
		const out: URI[] = [];
		const folder = this.primaryFolder();
		if (folder) {
			out.push(joinPath(folder, '.frame', 'config', 'runtime.json'));
		}
		const home = this.pathService.userHome({ preferLocal: true });
		out.push(joinPath(home, '.frame', 'config', 'runtime.json'));
		out.push(joinPath(home, '.frame-dev', 'config', 'runtime.json'));
		return out;
	}

	private async loadConfig(): Promise<void> {
		for (const uri of this.configCandidateUris()) {
			try {
				if (!(await this.fileService.exists(uri))) {
					continue;
				}
				const buf = await this.fileService.readFile(uri);
				const parsed = JSON.parse(buf.value.toString()) as Partial<IFrameRuntimeConfig>;
				this._config = {
					runtime: normalizeRuntimeKind(parsed.runtime ?? DEFAULT_CONFIG.runtime),
					activeModelId: parsed.activeModelId === undefined ? null : parsed.activeModelId,
					modelPath: parsed.modelPath === undefined ? null : parsed.modelPath,
					enabled: !!parsed.enabled,
					allowUnverifiedModels: parsed.allowUnverifiedModels === true,
					updatedAt: parsed.updatedAt,
				};
				this.logService.info(`[FrameRuntime] Loaded config from ${uri.fsPath} runtime=${this._config.runtime} enabled=${this._config.enabled} model=${this._config.activeModelId ?? '(none)'} modelPath=${this._config.modelPath ?? '(null)'}`);
				return;
			} catch (err) {
				this.logService.trace(`[FrameRuntime] Config candidate failed ${uri.fsPath}`, err);
			}
		}
		this._config = { ...DEFAULT_CONFIG };
		this.logService.info('[FrameRuntime] No runtime.json found — using stub defaults (open a folder or set ~/.frame/config/runtime.json)');
	}

	private async ensureConfigFile(): Promise<void> {
		const uri = this.configUri();
		if (!uri) {
			return;
		}
		if (await this.fileService.exists(uri)) {
			return;
		}
		await this.persistConfig();
	}

	private async persistConfig(): Promise<void> {
		const uri = this.configUri();
		if (!uri) {
			return;
		}
		const dir = joinPath(uri, '..');
		const parent = joinPath(dir, '..');
		await this.ensureDir(parent);
		await this.ensureDir(dir);
		const folder = this.primaryFolder();
		if (folder) {
			await this.ensureGitignore(folder);
		}
		const body = {
			runtime: this._config.runtime,
			activeModelId: this._config.activeModelId,
			modelPath: this._config.modelPath,
			enabled: this._config.enabled,
			allowUnverifiedModels: this._config.allowUnverifiedModels === true,
			updatedAt: this._config.updatedAt ?? Date.now(),
		};
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(body, null, 2) + '\n'));
	}

	/**
	 * Find a locally bundled Efficient fused GGUF (release zip / resources / cwd).
	 * Never downloads — only checks filesystem candidates.
	 */
	private async resolveBundledBaseModelPath(): Promise<string | null> {
		const folder = this.primaryFolder();
		const candidates = getFrameBundledBaseModelCandidates({
			cwd: folder?.fsPath
				?? (typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : undefined),
			appRoot: this.environmentService.appRoot,
			execPath: typeof process !== 'undefined' ? process.execPath : undefined,
		});
		for (const candidate of candidates) {
			if (await this.fileExists(candidate)) {
				return candidate;
			}
		}
		return null;
	}

	private async fileExists(fsPath: string): Promise<boolean> {
		try {
			return await this.fileService.exists(URI.file(fsPath));
		} catch {
			return false;
		}
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
}

function isGgufPath(path: string | null | undefined): boolean {
	return !!path && path.toLowerCase().endsWith('.gguf');
}

function normalizeSeparators(path: string): string {
	return path.replace(/\\/g, '/');
}

function normalizeRuntimeKind(raw: string): FrameRuntimeKind {
	switch (raw) {
		case 'mlx':
		case 'future-mlx':
			return 'mlx';
		case 'llamacpp':
		case 'llama.cpp':
		case 'future-llamacpp':
			return 'llamacpp';
		case 'stub':
			return 'stub';
		case 'none':
			return 'none';
		default:
			return 'stub';
	}
}

function describeRuntime(kind: FrameRuntimeKind): string {
	switch (kind) {
		case 'stub':
			return 'Placeholder local runtime — no weights loaded.';
		case 'mlx':
			return 'Apple MLX backend (future) — user-provided local weights only.';
		case 'llamacpp':
			return 'llama.cpp backend — user-provided GGUF via Frame model worker.';
		case 'none':
			return 'No runtime selected.';
		default:
			return 'Local inference backend.';
	}
}
