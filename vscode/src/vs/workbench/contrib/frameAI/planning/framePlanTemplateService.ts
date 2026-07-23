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
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { defaultFramePlanMatcher, FramePlanMatcher, IFramePlanMatchContext } from './framePlanMatcher.js';
import {
	createBuiltinPlanTemplates,
	IFramePlanStyleStats,
	IFramePlanTemplate,
	IFramePlanTemplateMatch,
	toFramePlanFile,
	validateFramePlanFile,
} from './framePlanTemplates.js';

export const IFramePlanTemplateService = createDecorator<IFramePlanTemplateService>('framePlanTemplateService');

export type FramePlanStyleEvent = 'rename' | 'disable' | 'reorder' | 'duplicate' | 'apply';

export interface IFramePlanTemplateService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeTemplates: Event<void>;

	readonly matcher: FramePlanMatcher;

	refresh(): Promise<void>;

	listTemplates(): readonly IFramePlanTemplate[];

	getTemplate(id: string): IFramePlanTemplate | undefined;

	matchTemplates(context: IFramePlanMatchContext): IFramePlanTemplateMatch[];

	getSuggested(context: IFramePlanMatchContext): IFramePlanTemplateMatch | undefined;

	favorites(): readonly IFramePlanTemplate[];

	recentTemplates(limit?: number): readonly IFramePlanTemplate[];

	projectTemplates(): readonly IFramePlanTemplate[];

	saveTemplate(template: Omit<IFramePlanTemplate, 'id' | 'source' | 'lastUsed' | 'usageCount'> & {
		readonly id?: string;
		readonly source?: IFramePlanTemplate['source'];
	}, scope?: 'workspace' | 'global'): Promise<IFramePlanTemplate>;

	deleteTemplate(id: string): Promise<boolean>;

	renameTemplate(id: string, name: string): Promise<IFramePlanTemplate | undefined>;

	duplicateTemplate(id: string): Promise<IFramePlanTemplate | undefined>;

	favoriteTemplate(id: string, favorite?: boolean): Promise<IFramePlanTemplate | undefined>;

	markUsed(id: string): Promise<void>;

	exportTemplate(id: string): Promise<string | undefined>;

	importTemplate(jsonText: string, scope?: 'workspace' | 'global'): Promise<IFramePlanTemplate | undefined>;

	recordStyleEvent(event: FramePlanStyleEvent): Promise<void>;

	getStyleStats(): IFramePlanStyleStats;
}

/**
 * Loads builtin + workspace + global templates, matching, CRUD, import/export.
 */
export class FramePlanTemplateService extends Disposable implements IFramePlanTemplateService {

	declare readonly _serviceBrand: undefined;

	readonly matcher: FramePlanMatcher = defaultFramePlanMatcher;

	private _templates: IFramePlanTemplate[] = [...createBuiltinPlanTemplates()];
	private _stats: IFramePlanStyleStats = {
		renamedSteps: 0,
		disabledSteps: 0,
		reorderedSteps: 0,
		duplicatedPlans: 0,
		templatesApplied: 0,
		updatedAt: Date.now(),
	};
	private _meta = new Map<string, { favorite?: boolean; lastUsed: number | null; usageCount: number }>();

	private readonly _onDidChangeTemplates = this._register(new Emitter<void>());
	readonly onDidChangeTemplates: Event<void> = this._onDidChangeTemplates.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IPathService private readonly pathService: IPathService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.logService.info('[FramePlanTemplates] Service ready (builtin + workspace + global)');
		void this.refresh();
	}

	async refresh(): Promise<void> {
		const builtins = createBuiltinPlanTemplates().map(t => this.applyMeta(t));
		const workspace = await this.loadDir(this.workspaceTemplatesDir(), 'workspace');
		const global = await this.loadDir(this.globalTemplatesDir(), 'global');
		await this.loadMeta();
		await this.loadStats();

		const byId = new Map<string, IFramePlanTemplate>();
		for (const t of builtins) {
			byId.set(t.id, this.applyMeta(t));
		}
		// Workspace overrides global and builtin by id/name
		for (const t of global) {
			byId.set(t.id, this.applyMeta(t));
		}
		for (const t of workspace) {
			byId.set(t.id, this.applyMeta(t));
			// Also override same name from lower layers
			for (const [id, existing] of byId) {
				if (id !== t.id && existing.name === t.name && existing.source !== 'workspace') {
					byId.delete(id);
				}
			}
		}
		this._templates = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
		this._onDidChangeTemplates.fire();
	}

	listTemplates(): readonly IFramePlanTemplate[] {
		return this._templates;
	}

	getTemplate(id: string): IFramePlanTemplate | undefined {
		return this._templates.find(t => t.id === id);
	}

	matchTemplates(context: IFramePlanMatchContext): IFramePlanTemplateMatch[] {
		return this.matcher.match(this._templates, context);
	}

	getSuggested(context: IFramePlanMatchContext): IFramePlanTemplateMatch | undefined {
		return this.matcher.bestMatch(this._templates, context);
	}

	favorites(): readonly IFramePlanTemplate[] {
		return this._templates.filter(t => t.favorite);
	}

	recentTemplates(limit = 8): readonly IFramePlanTemplate[] {
		return [...this._templates]
			.filter(t => t.lastUsed)
			.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
			.slice(0, limit);
	}

	projectTemplates(): readonly IFramePlanTemplate[] {
		return this._templates.filter(t => t.source === 'workspace');
	}

	async saveTemplate(
		template: Omit<IFramePlanTemplate, 'id' | 'source' | 'lastUsed' | 'usageCount'> & {
			readonly id?: string;
			readonly source?: IFramePlanTemplate['source'];
		},
		scope: 'workspace' | 'global' = 'workspace',
	): Promise<IFramePlanTemplate> {
		const full: IFramePlanTemplate = {
			...template,
			id: template.id ?? generateUuid(),
			source: scope === 'global' ? 'global' : (template.source === 'imported' ? 'imported' : 'workspace'),
			lastUsed: template.id ? (this.getTemplate(template.id)?.lastUsed ?? null) : null,
			usageCount: template.id ? (this.getTemplate(template.id)?.usageCount ?? 0) : 0,
			editable: true,
		};
		const dir = scope === 'global' ? this.globalTemplatesDir() : this.workspaceTemplatesDir();
		if (!dir) {
			throw new Error(scope === 'global' ? 'No user home for global templates.' : 'Open a workspace folder to save templates.');
		}
		await this.ensureDir(dir);
		const file = toFramePlanFile(full);
		const safe = full.name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48);
		const uri = joinPath(dir, `${safe}.frameplan`);
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(file, null, 2) + '\n'));
		await this.refresh();
		return this.getTemplate(full.id) ?? full;
	}

	async deleteTemplate(id: string): Promise<boolean> {
		const template = this.getTemplate(id);
		if (!template || template.source === 'builtin' || !template.editable) {
			return false;
		}
		const dirs = [this.workspaceTemplatesDir(), this.globalTemplatesDir()].filter(Boolean) as URI[];
		for (const dir of dirs) {
			try {
				const resolved = await this.fileService.resolve(dir);
				for (const child of resolved.children ?? []) {
					if (!child.name.endsWith('.frameplan')) {
						continue;
					}
					const buf = await this.fileService.readFile(child.resource);
					const parsed = JSON.parse(buf.value.toString());
					const validated = validateFramePlanFile(parsed);
					if (validated.ok && validated.file.template.id === id) {
						await this.fileService.del(child.resource);
						await this.refresh();
						return true;
					}
				}
			} catch {
				// skip
			}
		}
		return false;
	}

	async renameTemplate(id: string, name: string): Promise<IFramePlanTemplate | undefined> {
		const template = this.getTemplate(id);
		const trimmed = name.trim();
		if (!template || !trimmed || template.source === 'builtin') {
			return undefined;
		}
		return this.saveTemplate({ ...template, name: trimmed }, template.source === 'global' ? 'global' : 'workspace');
	}

	async duplicateTemplate(id: string): Promise<IFramePlanTemplate | undefined> {
		const template = this.getTemplate(id);
		if (!template) {
			return undefined;
		}
		const copy = await this.saveTemplate({
			...template,
			id: generateUuid(),
			name: `${template.name} Copy`,
			editable: true,
			favorite: false,
			source: 'workspace',
		}, 'workspace');
		await this.recordStyleEvent('duplicate');
		return copy;
	}

	async favoriteTemplate(id: string, favorite = true): Promise<IFramePlanTemplate | undefined> {
		const template = this.getTemplate(id);
		if (!template) {
			return undefined;
		}
		const meta = this._meta.get(id) ?? { lastUsed: template.lastUsed, usageCount: template.usageCount };
		this._meta.set(id, { ...meta, favorite });
		await this.persistMeta();
		await this.refresh();
		return this.getTemplate(id);
	}

	async markUsed(id: string): Promise<void> {
		const template = this.getTemplate(id);
		if (!template) {
			return;
		}
		const meta = this._meta.get(id) ?? { lastUsed: null, usageCount: 0, favorite: template.favorite };
		this._meta.set(id, {
			...meta,
			lastUsed: Date.now(),
			usageCount: (meta.usageCount ?? 0) + 1,
		});
		await this.persistMeta();
		await this.recordStyleEvent('apply');
		await this.refresh();
	}

	async exportTemplate(id: string): Promise<string | undefined> {
		const template = this.getTemplate(id);
		if (!template) {
			return undefined;
		}
		return JSON.stringify(toFramePlanFile(template), null, 2) + '\n';
	}

	async importTemplate(jsonText: string, scope: 'workspace' | 'global' = 'workspace'): Promise<IFramePlanTemplate | undefined> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonText);
		} catch {
			return undefined;
		}
		const validated = validateFramePlanFile(parsed);
		if (!validated.ok) {
			this.logService.warn(`[FramePlanTemplates] Import failed: ${validated.error}`);
			return undefined;
		}
		const t = validated.file.template;
		return this.saveTemplate({
			...t,
			id: generateUuid(),
			source: 'imported',
			editable: true,
		}, scope);
	}

	async recordStyleEvent(event: FramePlanStyleEvent): Promise<void> {
		this._stats = {
			renamedSteps: this._stats.renamedSteps + (event === 'rename' ? 1 : 0),
			disabledSteps: this._stats.disabledSteps + (event === 'disable' ? 1 : 0),
			reorderedSteps: this._stats.reorderedSteps + (event === 'reorder' ? 1 : 0),
			duplicatedPlans: this._stats.duplicatedPlans + (event === 'duplicate' ? 1 : 0),
			templatesApplied: this._stats.templatesApplied + (event === 'apply' ? 1 : 0),
			updatedAt: Date.now(),
		};
		await this.persistStats();
	}

	getStyleStats(): IFramePlanStyleStats {
		return this._stats;
	}

	private applyMeta(template: IFramePlanTemplate): IFramePlanTemplate {
		const meta = this._meta.get(template.id);
		if (!meta) {
			return template;
		}
		return {
			...template,
			favorite: meta.favorite ?? template.favorite,
			lastUsed: meta.lastUsed ?? template.lastUsed,
			usageCount: meta.usageCount ?? template.usageCount,
		};
	}

	private workspaceTemplatesDir(): URI | undefined {
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		return folder ? joinPath(folder, '.frame', 'plans', 'templates') : undefined;
	}

	private globalTemplatesDir(): URI {
		return joinPath(this.pathService.userHome({ preferLocal: true }), '.frame', 'templates');
	}

	private async loadDir(dir: URI | undefined, source: IFramePlanTemplate['source']): Promise<IFramePlanTemplate[]> {
		if (!dir) {
			return [];
		}
		try {
			if (!(await this.fileService.exists(dir))) {
				return [];
			}
			const resolved = await this.fileService.resolve(dir);
			const out: IFramePlanTemplate[] = [];
			for (const child of resolved.children ?? []) {
				if (!child.name.endsWith('.frameplan') || child.isDirectory) {
					continue;
				}
				try {
					const buf = await this.fileService.readFile(child.resource);
					const validated = validateFramePlanFile(JSON.parse(buf.value.toString()));
					if (validated.ok) {
						out.push({
							...validated.file.template,
							source,
							editable: source !== 'builtin',
						});
					}
				} catch {
					// skip
				}
			}
			return out;
		} catch {
			return [];
		}
	}

	private metaUri(): URI | undefined {
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		return folder ? joinPath(folder, '.frame', 'plans', 'template-meta.json') : undefined;
	}

	private statsUri(): URI | undefined {
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		return folder ? joinPath(folder, '.frame', 'plans', 'template-style-stats.json') : undefined;
	}

	private async loadMeta(): Promise<void> {
		const uri = this.metaUri();
		if (!uri || !(await this.fileService.exists(uri))) {
			return;
		}
		try {
			const buf = await this.fileService.readFile(uri);
			const parsed = JSON.parse(buf.value.toString()) as Record<string, { favorite?: boolean; lastUsed: number | null; usageCount: number }>;
			this._meta = new Map(Object.entries(parsed));
		} catch {
			// ignore
		}
	}

	private async persistMeta(): Promise<void> {
		const uri = this.metaUri();
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		if (!uri || !folder) {
			return;
		}
		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(joinPath(folder, '.frame', 'plans'));
		const obj: Record<string, unknown> = {};
		for (const [k, v] of this._meta) {
			obj[k] = v;
		}
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(obj, null, 2) + '\n'));
	}

	private async loadStats(): Promise<void> {
		const uri = this.statsUri();
		if (!uri || !(await this.fileService.exists(uri))) {
			return;
		}
		try {
			const buf = await this.fileService.readFile(uri);
			this._stats = { ...this._stats, ...JSON.parse(buf.value.toString()) };
		} catch {
			// ignore
		}
	}

	private async persistStats(): Promise<void> {
		const uri = this.statsUri();
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		if (!uri || !folder) {
			return;
		}
		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(joinPath(folder, '.frame', 'plans'));
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(this._stats, null, 2) + '\n'));
	}

	private async ensureDir(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// exists
		}
	}
}
