/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import './media/frameAI.css';

import * as DOM from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { URI } from '../../../../base/common/uri.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { FrameAdapterScope, FrameAdapterState, FrameTrainingJobStatus, IFrameCandidatePreference, IFrameEditionRecommendation, IFrameHardwareProfile, IFrameModelDescriptor, IFrameRuntimeStatus, IFrameTrainingJob } from '../common/models.js';
import { IFrameAdapterListItem } from '../adapters/frameAdapterManagement.js';
import { isFrameBuiltinAdapter } from '../adapters/frameBuiltinAdapters.js';
import { FRAME_STUB_PLAN_MESSAGE } from '../runtime/frameEditPlan.js';
import { IFrameIntelligenceService } from '../services/frameIntelligence.js';
import { FRAME_AI_VIEW_ID } from './frameAI.js';

const $ = DOM.$;

/**
 * Left Activity Bar control panel for Frame AI.
 * Conversation lives in the right-side Chat (Auxiliary Bar) via FrameChatAgent.
 *
 * Collapsible sections: Models / Preview / Tools expanded by default;
 * Hardware, stats, learning, knowledge, plan review, background, training,
 * and adapters start collapsed — no chat composer.
 */
export class FrameAIViewPane extends ViewPane {

	static readonly ID = FRAME_AI_VIEW_ID;

	private root!: HTMLElement;
	/** Sole scrollport: all sections append here. */
	private scrollBody!: HTMLElement;
	private hardwareBodyEl!: HTMLElement;
	private modelBodyEl!: HTMLElement;
	private statsBodyEl!: HTMLElement;
	private learningBodyEl!: HTMLElement;
	private knowledgeBodyEl!: HTMLElement;
	private planReviewBodyEl!: HTMLElement;
	private toolsBodyEl!: HTMLElement;
	private editsBodyEl!: HTMLElement;
	private backgroundBodyEl!: HTMLElement;
	private trainingBodyEl!: HTMLElement;
	private adaptersBodyEl!: HTMLElement;
	private importInputEl!: HTMLTextAreaElement;
	private lastImportedAdapterId: string | undefined;
	private statusEl!: HTMLElement;
	private expandedAdapterId: string | undefined;
	/** Live auto-approve countdown label while an Edit-mode plan awaits review. */
	private planReviewCountdownEl: HTMLElement | undefined;
	private readonly actionStore = this._register(new DisposableStore());
	private readonly learningActions = this._register(new DisposableStore());
	private readonly knowledgeActions = this._register(new DisposableStore());
	private readonly planReviewActions = this._register(new DisposableStore());
	private readonly editsActions = this._register(new DisposableStore());
	private readonly backgroundActions = this._register(new DisposableStore());
	private readonly trainingActions = this._register(new DisposableStore());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IFrameIntelligenceService private readonly intelligence: IFrameIntelligenceService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		// Ensure the ViewPane body can host a flex scroll child.
		container.style.height = '100%';
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.minHeight = '0';
		container.style.overflow = 'hidden';

		this.root = DOM.append(container, $('.frame-ai-view.frame-ai-control'));
		this.root.setAttribute('role', 'region');
		this.root.setAttribute('aria-label', localize('frameAI.ariaLabel', "Frame"));

		const stickyHeader = DOM.append(this.root, $('.frame-ai-control-sticky'));
		const welcome = DOM.append(stickyHeader, $('.frame-ai-welcome'));
		DOM.append(welcome, $('h2.frame-ai-welcome-title', undefined, localize('frameAI.welcomeTitle', "Frame")));
		DOM.append(welcome, $('p.frame-ai-welcome-subtitle', undefined, localize(
			'frameAI.welcomeSubtitle',
			"Hardware, models, adapters, and local intelligence controls. Chat with Frame in the panel on the right.",
		)));

		this.statusEl = DOM.append(stickyHeader, $('p.frame-ai-control-status'));
		this.statusEl.setAttribute('aria-live', 'polite');

		// Native overflow — one scroller for the whole panel body.
		this.scrollBody = DOM.append(this.root, $('.frame-ai-control-scroll'));

		// Primary (expanded): Models → Preview Changes → Tool Activity
		this.modelBodyEl = this.renderSection('models', localize('frameAI.modelsTitle', "Models"), localize('frameAI.modelsControlHint', "Activate a model, set path, and enable the local runtime."), true);
		this.editsBodyEl = this.renderSection('edits', localize('frameAI.editsTitle', "Preview Changes"), localize('frameAI.editsHint', "Pending workspace edit plan. Chat may also apply non-stub plans."), true);
		this.toolsBodyEl = this.renderSection('tools', localize('frameAI.toolsTitle', "Tool Activity"), localize('frameAI.toolsHint', "Current and recent local tool calls."), true);

		// Secondary (collapsed): everything else for chat-first users
		this.hardwareBodyEl = this.renderSection('hardware', localize('frameAI.hardwareTitle', "Hardware"), localize('frameAI.hardwareHint', "Detected machine profile for local model fit."), false);
		this.statsBodyEl = this.renderSection('stats', localize('frameAI.statsTitle', "Runtime stats"), localize('frameAI.statsHint', "Worker status, RAM, and last inference timing."), false);
		this.learningBodyEl = this.renderSection('learning', localize('frameAI.learningTitle', "Learning"), localize('frameAI.learningHint', "Candidate preferences awaiting Approve / Reject."), false);
		this.knowledgeBodyEl = this.renderSection('knowledge', localize('frameAI.knowledgeTitle', "Knowledge"), localize('frameAI.knowledgeHint', "Workspace knowledge graph index status."), false);
		this.planReviewBodyEl = this.renderSection('plan-review', localize('frameAI.planReviewTitle', "Plan Review"), localize('frameAI.planReviewHint', "Edit mode only — approve or reject before tools run (auto-approves after 20s)."), false);
		this.backgroundBodyEl = this.renderSection('background', localize('frameAI.backgroundTitle', "Background"), localize('frameAI.backgroundHint', "Idle local maintenance (index, RAG, preference candidates)."), false);
		this.trainingBodyEl = this.renderSection('training', localize('frameAI.trainingTitle', "LoRA training"), localize(
			'frameAI.trainingHint',
			"Fine-tunes Qwen on data/processed via MLX. Jobs started here or in the terminal show up automatically.",
		), false);

		this.renderAdaptersSection();

		this._register(this.intelligence.hardware.onDidChangeHardware(() => this.refreshAll()));
		this._register(this.intelligence.models.onDidChangeModels(() => this.refreshAll()));
		this._register(this.intelligence.runtimes.onDidChangeStatus(() => this.refreshAll()));
		this._register(this.intelligence.modelWorker.onDidChangeHealth(() => this.refreshAll()));
		this._register(this.intelligence.adapterManagement.onDidChange(() => this.refreshAdapters()));
		this._register(this.intelligence.training.onDidChangeJobs(() => this.refreshTraining()));
		this._register(this.intelligence.orchestrator.onDidCompleteTask(() => this.refreshStats()));
		this._register(this.intelligence.preferenceReview.onDidChange(() => this.refreshLearning()));
		this._register(this.intelligence.observations.onDidChange(() => this.refreshLearning()));
		this._register(this.intelligence.knowledge.onDidChangeGraph(() => this.refreshKnowledge()));
		this._register(this.intelligence.planReview.onDidChangeReview(() => this.refreshPlanReview()));
		this._register(this.intelligence.tools.onDidChangeActivity(() => this.refreshTools()));
		this._register(this.intelligence.workspaceEdits.onDidChangePlans(() => this.refreshEdits()));

		const backgroundTimer = setInterval(() => this.refreshBackground(), 15_000);
		this._register(toDisposable(() => clearInterval(backgroundTimer)));
		const planReviewCountdownTimer = setInterval(() => this.tickPlanReviewCountdown(), 1_000);
		this._register(toDisposable(() => clearInterval(planReviewCountdownTimer)));

		void this.intelligence.hardware.detect().then(() => this.refreshAll());
		void this.intelligence.models.refresh().then(() => this.refreshAll());
		void this.intelligence.runtimes.initialize().then(() => this.refreshAll());
		void this.intelligence.adapterManagement.refresh().then(() => this.refreshAdapters());
		void this.intelligence.knowledge.ensureIndexed().then(() => this.refreshKnowledge());
		void this.intelligence.training.probe().then(() => this.refreshTraining());
		void this.intelligence.training.refresh().then(() => this.refreshTraining());
		this.refreshAll();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (!this.root) {
			return;
		}
		const h = Math.max(0, height);
		const w = Math.max(0, width);
		// Pane body itself has no fixed height from Pane — size it so flex scroll works.
		const parent = this.root.parentElement;
		if (parent) {
			parent.style.height = `${h}px`;
			parent.style.width = `${w}px`;
			parent.style.overflow = 'hidden';
		}
		this.root.style.height = `${h}px`;
		this.root.style.width = `${w}px`;
		this.root.classList.toggle('narrow', w < 280);
	}

	private renderSection(key: string, title: string, hint: string, expanded: boolean): HTMLElement {
		const section = DOM.append(this.scrollBody, $(`.frame-ai-section.frame-ai-${key}${expanded ? '.is-expanded' : '.is-collapsed'}`));
		section.setAttribute('role', 'region');
		section.setAttribute('aria-label', title);

		const header = DOM.append(section, $('button.frame-ai-section-header')) as HTMLButtonElement;
		header.type = 'button';
		header.setAttribute('aria-expanded', String(expanded));
		header.setAttribute('aria-controls', `frame-ai-section-body-${key}`);

		const titleRow = DOM.append(header, $('.frame-ai-section-title-row'));
		DOM.append(titleRow, $('span.frame-ai-section-chevron'));
		DOM.append(titleRow, $('span.frame-ai-section-title', undefined, title));
		DOM.append(header, $('span.frame-ai-section-hint', undefined, hint));

		const body = DOM.append(section, $('.frame-ai-section-body'));
		body.id = `frame-ai-section-body-${key}`;
		this._register(DOM.addDisposableListener(header, 'click', () => {
			const nextExpanded = section.classList.contains('is-collapsed');
			section.classList.toggle('is-collapsed', !nextExpanded);
			section.classList.toggle('is-expanded', nextExpanded);
			header.setAttribute('aria-expanded', String(nextExpanded));
		}));
		return body;
	}

	private renderAdaptersSection(): void {
		const section = DOM.append(this.scrollBody, $('.frame-ai-section.frame-ai-adapters.is-collapsed'));
		section.setAttribute('role', 'region');
		section.setAttribute('aria-label', localize('frameAI.adaptersAria', "Adapters"));

		const header = DOM.append(section, $('button.frame-ai-section-header')) as HTMLButtonElement;
		header.type = 'button';
		header.setAttribute('aria-expanded', 'false');
		header.setAttribute('aria-controls', 'frame-ai-section-body-adapters');
		const titleRow = DOM.append(header, $('.frame-ai-section-title-row'));
		DOM.append(titleRow, $('span.frame-ai-section-chevron'));
		DOM.append(titleRow, $('span.frame-ai-section-title', undefined, localize('frameAI.adaptersTitle', "LoRA adapters")));
		DOM.append(header, $('span.frame-ai-section-hint', undefined, localize(
			'frameAI.adaptersHint',
			"Frame agent LoRA is built-in and always on. Extra adapters live under .frame/adapters/<id>/. Drop optional .gguf weights to stack language/project/user LoRAs.",
		)));
		this._register(DOM.addDisposableListener(header, 'click', () => {
			const nextExpanded = section.classList.contains('is-collapsed');
			section.classList.toggle('is-collapsed', !nextExpanded);
			section.classList.toggle('is-expanded', nextExpanded);
			header.setAttribute('aria-expanded', String(nextExpanded));
		}));

		const body = DOM.append(section, $('.frame-ai-section-body'));
		body.id = 'frame-ai-section-body-adapters';

		const dropPanel = DOM.append(body, $('.frame-ai-adapter-drop'));
		DOM.append(dropPanel, $('div.frame-ai-adapter-drop-title', undefined, localize(
			'frameAI.adapterDropTitle',
			"Drop LoRA weight file",
		)));
		DOM.append(dropPanel, $('p.frame-ai-adapter-drop-hint', undefined, localize(
			'frameAI.adapterDropHint',
			"Drop a .gguf (preferred) or .safetensors file here, or browse. Creates a new adapter entry and copies the file into this workspace.",
		)));
		const dropActions = DOM.append(dropPanel, $('.frame-ai-adapter-drop-actions'));
		const browseBtn = DOM.append(dropActions, $('button.frame-ai-gen-action')) as HTMLButtonElement;
		browseBtn.type = 'button';
		browseBtn.textContent = localize('frameAI.adapterBrowse', "Browse…");
		const browseLinkBtn = DOM.append(dropActions, $('button.frame-ai-gen-action.secondary')) as HTMLButtonElement;
		browseLinkBtn.type = 'button';
		browseLinkBtn.textContent = localize('frameAI.adapterBrowseLink', "Link to selected…");
		this._register(DOM.addDisposableListener(browseBtn, 'click', () => void this.onBrowseWeightFile({ asNew: true })));
		this._register(DOM.addDisposableListener(browseLinkBtn, 'click', () => void this.onBrowseWeightFile({ asNew: false })));
		this._register(DOM.addDisposableListener(dropPanel, 'dragover', e => {
			e.preventDefault();
			e.stopPropagation();
			dropPanel.classList.add('drag-over');
		}));
		this._register(DOM.addDisposableListener(dropPanel, 'dragleave', () => dropPanel.classList.remove('drag-over')));
		this._register(DOM.addDisposableListener(dropPanel, 'drop', e => {
			e.preventDefault();
			e.stopPropagation();
			dropPanel.classList.remove('drag-over');
			const path = extractDroppedFilePath(e);
			if (!path) {
				this.setStatus(localize('frameAI.adapterDropNoPath', "Could not read dropped file path. Use Browse instead."));
				return;
			}
			void this.onImportWeightPath(path, { asNew: true, activate: true });
		}));

		const importPanel = DOM.append(body, $('.frame-ai-adapter-import'));
		DOM.append(importPanel, $('div.frame-ai-adapter-import-label', undefined, localize(
			'frameAI.adapterPackageLabel',
			"Optional: paste metadata package JSON (weights still need a file)",
		)));
		this.importInputEl = DOM.append(importPanel, $('textarea.frame-ai-adapter-import-input')) as HTMLTextAreaElement;
		this.importInputEl.rows = 3;
		this.importInputEl.placeholder = localize('frameAI.adapterImportPlaceholder', "Paste adapter package JSON…");
		this.importInputEl.setAttribute('aria-label', localize('frameAI.adapterImportAria', "Adapter package JSON"));

		const importActions = DOM.append(importPanel, $('.frame-ai-adapter-import-actions'));
		const validateBtn = DOM.append(importActions, $('button.frame-ai-gen-action secondary')) as HTMLButtonElement;
		validateBtn.type = 'button';
		validateBtn.textContent = localize('frameAI.adapterValidate', "Validate");
		const importBtn = DOM.append(importActions, $('button.frame-ai-gen-action.secondary')) as HTMLButtonElement;
		importBtn.type = 'button';
		importBtn.textContent = localize('frameAI.adapterImport', "Import JSON");
		this._register(DOM.addDisposableListener(validateBtn, 'click', () => this.onValidatePackage()));
		this._register(DOM.addDisposableListener(importBtn, 'click', () => this.onImportPackage()));

		this.adaptersBodyEl = DOM.append(body, $('.frame-ai-adapters-body'));
	}

	private refreshAll(): void {
		this.refreshHardware();
		this.refreshModels();
		this.refreshStats();
		this.refreshLearning();
		this.refreshKnowledge();
		this.refreshPlanReview();
		this.refreshTools();
		this.refreshEdits();
		this.refreshBackground();
		this.refreshTraining();
		this.refreshAdapters();
	}

	private refreshHardware(): void {
		if (!this.hardwareBodyEl) {
			return;
		}
		DOM.clearNode(this.hardwareBodyEl);
		const hw = this.intelligence.hardware.getCachedProfile();
		if (!hw) {
			DOM.append(this.hardwareBodyEl, $('p.frame-ai-empty', undefined, localize('frameAI.hardwareDetecting', "Detecting hardware…")));
			return;
		}
		this.appendRows(this.hardwareBodyEl, [
			[localize('frameAI.hwOs', "OS"), hw.osLabel],
			[localize('frameAI.hwArch', "Architecture"), hw.architecture],
			[localize('frameAI.hwCpu', "CPU"), hw.cpuModel ?? localize('frameAI.unknown', "Unknown")],
			[localize('frameAI.hwRam', "RAM"), `${hw.ramGB} GB${hw.freeRamGB !== undefined ? ` (${hw.freeRamGB} GB free)` : ''}`],
			[localize('frameAI.hwGpu', "GPU"), formatGpu(hw)],
		]);
	}

	private refreshModels(): void {
		if (!this.modelBodyEl) {
			return;
		}
		DOM.clearNode(this.modelBodyEl);
		this.actionStore.clear();

		const active = this.intelligence.models.getActiveModel();
		const status = this.intelligence.runtimes.getStatus();

		// Primary actions first: enable runtime + model path
		this.renderRuntimeConfig(this.modelBodyEl);

		const activeCard = DOM.append(this.modelBodyEl, $('.frame-ai-model-card.frame-ai-model-primary'));
		DOM.append(activeCard, $('div.frame-ai-model-card-title', undefined, localize('frameAI.activeModel', "Active model")));
		if (active) {
			DOM.append(activeCard, $('div.frame-ai-model-name', undefined, active.displayName));
			DOM.append(activeCard, $('div.frame-ai-model-meta', undefined, `${active.edition} · ${active.precision ?? ''}`.trim()));
			if (status.modelPath) {
				DOM.append(activeCard, $('div.frame-ai-model-path', undefined, status.modelPath));
			}
		} else {
			DOM.append(activeCard, $('p.frame-ai-empty', undefined, localize('frameAI.noActiveModel', "No active model. Select a recommendation below.")));
		}

		const recCard = DOM.append(this.modelBodyEl, $('.frame-ai-model-card'));
		DOM.append(recCard, $('div.frame-ai-model-card-title', undefined, localize('frameAI.recommendedModel', "Recommended")));
		const recPlaceholder = DOM.append(recCard, $('p.frame-ai-empty', undefined, localize('frameAI.recLoading', "Computing recommendation…")));

		void this.intelligence.modelInstaller.recommendBestEdition().then(rec => {
			DOM.clearNode(recCard);
			DOM.append(recCard, $('div.frame-ai-model-card-title', undefined, localize('frameAI.recommendedModel', "Recommended")));
			this.renderRecommendation(recCard, rec, active);
		}, () => {
			recPlaceholder.textContent = localize('frameAI.recFail', "Could not compute recommendation.");
		});

		const list = this.intelligence.models.listModels();
		if (list.length) {
			const picker = DOM.append(this.modelBodyEl, $('.frame-ai-model-picker'));
			DOM.append(picker, $('div.frame-ai-model-card-title', undefined, localize('frameAI.availableModels', "Available profiles")));
			for (const model of list.slice(0, 8)) {
				this.renderModelRow(picker, model, active?.id);
			}
		}
	}

	private renderRuntimeConfig(parent: HTMLElement): void {
		const config = this.intelligence.runtimes.getConfig();
		const panel = DOM.append(parent, $('.frame-ai-runtime-config.frame-ai-model-primary'));
		DOM.append(panel, $('div.frame-ai-runtime-config-label', undefined, localize('frameAI.runtimeConfig', "Load & enable")));

		const enableRow = DOM.append(panel, $('.frame-ai-runtime-row'));
		DOM.append(enableRow, $('span.frame-ai-runtime-row-label', undefined, localize('frameAI.runtimeEnabled', "Enabled")));
		const enableBtn = DOM.append(enableRow, $(config.enabled ? 'button.frame-ai-gen-action' : 'button.frame-ai-gen-action.secondary')) as HTMLButtonElement;
		enableBtn.type = 'button';
		enableBtn.textContent = config.enabled
			? localize('frameAI.runtimeOn', "On")
			: localize('frameAI.runtimeOff', "Off — click to enable");
		this.actionStore.add(DOM.addDisposableListener(enableBtn, 'click', () => {
			void this.intelligence.runtimes.updateConfig({ enabled: !config.enabled }).then(() => {
				this.setStatus(localize(
					'frameAI.runtimeToggled',
					"Runtime {0}.",
					!config.enabled ? localize('frameAI.runtimeOn', "On") : localize('frameAI.runtimeOff', "Off"),
				));
				this.refreshModels();
				this.refreshStats();
			});
		}));

		const pathRow = DOM.append(panel, $('.frame-ai-runtime-row.stack'));
		DOM.append(pathRow, $('span.frame-ai-runtime-row-label', undefined, localize('frameAI.runtimeModelPath', "Model path")));
		const pathInput = DOM.append(pathRow, $('input.frame-ai-runtime-model-input')) as HTMLInputElement;
		pathInput.type = 'text';
		pathInput.value = config.modelPath ?? '';
		pathInput.placeholder = localize('frameAI.runtimeModelPathPlaceholder', "Absolute path to GGUF / weights…");
		pathInput.setAttribute('aria-label', localize('frameAI.runtimeModelPathAria', "Local model path"));

		const pathActions = DOM.append(pathRow, $('.frame-ai-runtime-model-actions'));
		const saveBtn = DOM.append(pathActions, $('button.frame-ai-gen-action')) as HTMLButtonElement;
		saveBtn.type = 'button';
		saveBtn.textContent = localize('frameAI.runtimeSavePath', "Save path");
		this.actionStore.add(DOM.addDisposableListener(saveBtn, 'click', () => {
			const trimmed = pathInput.value.trim();
			void this.intelligence.runtimes.updateConfig({ modelPath: trimmed || null }).then(() => {
				this.setStatus(localize('frameAI.runtimePathSaved', "Model path updated."));
				this.refreshModels();
				this.refreshStats();
			});
		}));
	}

	private renderRecommendation(parent: HTMLElement, rec: IFrameEditionRecommendation, active: IFrameModelDescriptor | undefined): void {
		DOM.append(parent, $('div.frame-ai-model-name', undefined, rec.displayName));
		DOM.append(parent, $('div.frame-ai-model-meta', undefined, rec.reason));
		DOM.append(parent, $('div.frame-ai-model-meta', undefined, rec.hardwareSummary));
		if (active?.id !== rec.modelId) {
			const btn = DOM.append(parent, $('button.frame-ai-gen-action')) as HTMLButtonElement;
			btn.type = 'button';
			btn.textContent = localize('frameAI.activateRecommended', "Set active");
			this.actionStore.add(DOM.addDisposableListener(btn, 'click', () => {
				void this.intelligence.models.selectActiveModel(rec.modelId).then(async model => {
					await this.intelligence.runtimes.updateConfig({
						activeModelId: rec.modelId,
						...(model?.localPath?.toLowerCase().endsWith('.gguf') ? { modelPath: model.localPath } : {}),
					});
					this.setStatus(localize('frameAI.modelActivated', "Active model set to {0}", rec.displayName));
					this.refreshModels();
				});
			}));
		}
	}

	private renderModelRow(parent: HTMLElement, model: IFrameModelDescriptor, activeId: string | undefined): void {
		const row = DOM.append(parent, $('.frame-ai-model-row'));
		DOM.append(row, $('div.frame-ai-model-name', undefined, model.displayName));
		DOM.append(row, $('div.frame-ai-model-meta', undefined, `${model.edition}${model.active || model.id === activeId ? ' · active' : ''}`));
		if (model.id !== activeId) {
			const btn = DOM.append(row, $('button.frame-ai-gen-action secondary')) as HTMLButtonElement;
			btn.type = 'button';
			btn.textContent = localize('frameAI.setActive', "Activate");
			this.actionStore.add(DOM.addDisposableListener(btn, 'click', () => {
				void this.intelligence.models.selectActiveModel(model.id).then(async selected => {
					await this.intelligence.runtimes.updateConfig({
						activeModelId: model.id,
						...(selected?.localPath?.toLowerCase().endsWith('.gguf') ? { modelPath: selected.localPath } : {}),
					});
					this.setStatus(localize('frameAI.modelActivated', "Active model set to {0}", model.displayName));
					this.refreshModels();
				});
			}));
		}
	}

	private refreshStats(): void {
		if (!this.statsBodyEl) {
			return;
		}
		DOM.clearNode(this.statsBodyEl);
		const status = this.intelligence.runtimes.getStatus();
		const health = this.intelligence.modelWorker.getHealth();
		const ram = health.memory.ramMb ?? health.memory.memoryUsage ?? null;
		const gpu = health.memory.gpuMb ?? health.memory.gpuUsage ?? null;
		const uptime = health.uptimeMs;

		this.appendRows(this.statsBodyEl, [
			[localize('frameAI.statsRuntime', "Runtime"), formatRuntime(status)],
			[localize('frameAI.statsWorker', "Worker"), status.execution?.worker ?? health.status],
			[localize('frameAI.statsModelLoad', "Model"), status.execution?.model ?? (status.activeModelId ? 'selected' : 'not loaded')],
			[localize('frameAI.statsInference', "Inference"), status.execution?.inference ? localize('frameAI.yes', "YES") : localize('frameAI.no', "NO")],
			[localize('frameAI.statsRam', "Worker RAM"), formatMb(ram)],
			[localize('frameAI.statsGpu', "Worker GPU"), formatMb(gpu)],
			[localize('frameAI.statsUptime', "Worker uptime"), `${Math.round(uptime / 1000)}s`],
			[localize('frameAI.statsHwRam', "System RAM"), (() => {
				const hw = this.intelligence.hardware.getCachedProfile();
				return hw ? `${hw.ramGB} GB` : '—';
			})()],
		]);
	}

	private refreshLearning(): void {
		if (!this.learningBodyEl) {
			return;
		}
		DOM.clearNode(this.learningBodyEl);
		this.learningActions.clear();

		const pending = this.intelligence.preferenceReview.getPendingPreferences();
		if (!pending.length) {
			DOM.append(this.learningBodyEl, $('p.frame-ai-empty', undefined, localize(
				'frameAI.learningEmpty',
				"No candidate preferences yet.",
			)));
			return;
		}

		for (const candidate of pending.slice(0, 8)) {
			this.renderPreferenceCard(candidate);
		}
	}

	private renderPreferenceCard(candidate: IFrameCandidatePreference): void {
		const card = DOM.append(this.learningBodyEl, $('.frame-ai-preference-card'));
		DOM.append(card, $('div.frame-ai-preference-text', undefined, candidate.preference));
		DOM.append(card, $('div.frame-ai-preference-meta', undefined, localize(
			'frameAI.preferenceMeta',
			"Confidence {0}% · {1} observations{2}",
			Math.round(candidate.confidence * 100),
			candidate.observationCount,
			candidate.language ? ` · ${candidate.language}` : '',
		)));
		const actions = DOM.append(card, $('.frame-ai-preference-actions'));
		this.addStoreAction(this.learningActions, actions, localize('frameAI.approvePreference', "Approve"), true, () => {
			void this.intelligence.preferenceReview.approvePreference(candidate.id).then(pref => {
				this.setStatus(pref
					? localize('frameAI.preferenceApproved', "Approved preference.")
					: localize('frameAI.preferenceApproveMiss', "Could not approve preference."));
				this.refreshLearning();
			});
		});
		this.addStoreAction(this.learningActions, actions, localize('frameAI.rejectPreference', "Reject"), false, () => {
			void this.intelligence.preferenceReview.rejectPreference(candidate.id).then(() => {
				this.setStatus(localize('frameAI.preferenceRejected', "Rejected preference."));
				this.refreshLearning();
			});
		});
	}

	private refreshKnowledge(): void {
		if (!this.knowledgeBodyEl) {
			return;
		}
		DOM.clearNode(this.knowledgeBodyEl);
		this.knowledgeActions.clear();

		const meta = this.intelligence.knowledge.getMetadata();
		this.appendRows(this.knowledgeBodyEl, [
			[localize('frameAI.knowledgeHealth', "Health"), meta.health],
			[localize('frameAI.knowledgeFiles', "Files"), String(meta.fileCount)],
			[localize('frameAI.knowledgeNodes', "Nodes"), String(meta.nodeCount)],
			[localize('frameAI.knowledgeEdges', "Edges"), String(meta.edgeCount)],
			[localize('frameAI.knowledgeSymbols', "Symbols"), String(meta.symbolCount)],
			[localize('frameAI.knowledgeIndexed', "Last indexed"), formatTimestamp(meta.lastIndexedAt)],
		]);
		if (meta.lastError) {
			DOM.append(this.knowledgeBodyEl, $('p.frame-ai-empty', undefined, meta.lastError));
		}

		const actions = DOM.append(this.knowledgeBodyEl, $('.frame-ai-knowledge-actions'));
		this.addStoreAction(this.knowledgeActions, actions, localize('frameAI.knowledgeEnsure', "Ensure indexed"), false, () => {
			void this.intelligence.knowledge.ensureIndexed().then(m => {
				this.setStatus(localize('frameAI.knowledgeEnsureOk', "Knowledge index ready ({0}).", m.health));
				this.refreshKnowledge();
			});
		});
		this.addStoreAction(this.knowledgeActions, actions, localize('frameAI.knowledgeRebuild', "Rebuild index"), true, () => {
			void this.intelligence.knowledge.rebuildIndex().then(m => {
				this.setStatus(localize(
					'frameAI.knowledgeRebuildOk',
					"Rebuilt: {0} files, {1} nodes.",
					m.fileCount,
					m.nodeCount,
				));
				this.refreshKnowledge();
			});
		});
	}

	private refreshPlanReview(): void {
		if (!this.planReviewBodyEl) {
			return;
		}
		DOM.clearNode(this.planReviewBodyEl);
		this.planReviewActions.clear();
		this.planReviewCountdownEl = undefined;

		const awaiting = this.intelligence.planReview.isAwaitingReview();
		const draft = this.intelligence.planReview.getDraft();
		if (!awaiting || !draft) {
			DOM.append(this.planReviewBodyEl, $('p.frame-ai-empty', undefined, localize(
				'frameAI.planReviewEmpty',
				"No Edit-mode plan awaiting review.",
			)));
			return;
		}

		const countdown = this.intelligence.planReview.getReviewCountdown();
		this.planReviewCountdownEl = DOM.append(this.planReviewBodyEl, $('div.frame-ai-plan-review-countdown'));
		this.updatePlanReviewCountdownLabel(countdown?.remainingMs ?? 0);

		DOM.append(this.planReviewBodyEl, $('div.frame-ai-plan-review-summary', undefined, draft.summary || draft.prompt.slice(0, 120)));
		this.appendRows(this.planReviewBodyEl, [
			[localize('frameAI.planReviewStatus', "Status"), draft.status],
			[localize('frameAI.planReviewSteps', "Steps"), String(draft.steps.length)],
			[localize('frameAI.planReviewEnabled', "Enabled"), String(draft.steps.filter(s => s.enabled !== false).length)],
		]);

		const list = DOM.append(this.planReviewBodyEl, $('.frame-ai-plan-review-list'));
		for (const step of draft.steps.slice(0, 8)) {
			const row = DOM.append(list, $('.frame-ai-plan-review-step'));
			DOM.append(row, $('div.frame-ai-plan-review-kind', undefined, `${step.enabled === false ? '○' : '●'} ${step.title}`));
			DOM.append(row, $('div.frame-ai-plan-review-kind', undefined, step.kind));
		}

		const actions = DOM.append(this.planReviewBodyEl, $('.frame-ai-plan-review-actions'));
		this.addStoreAction(this.planReviewActions, actions, localize('frameAI.planApprove', "Approve"), true, () => {
			this.intelligence.planReview.approve();
			this.setStatus(localize('frameAI.planApproved', "Plan approved."));
			this.refreshPlanReview();
		});
		this.addStoreAction(this.planReviewActions, actions, localize('frameAI.planReject', "Reject"), false, () => {
			this.intelligence.planReview.reject();
			this.setStatus(localize('frameAI.planRejected', "Plan rejected."));
			this.refreshPlanReview();
		});
	}

	private tickPlanReviewCountdown(): void {
		const countdown = this.intelligence.planReview.getReviewCountdown();
		if (!countdown) {
			if (this.planReviewCountdownEl) {
				this.refreshPlanReview();
			}
			return;
		}
		if (!this.planReviewCountdownEl) {
			this.refreshPlanReview();
			return;
		}
		this.updatePlanReviewCountdownLabel(countdown.remainingMs);
	}

	private updatePlanReviewCountdownLabel(remainingMs: number): void {
		if (!this.planReviewCountdownEl) {
			return;
		}
		const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
		this.planReviewCountdownEl.textContent = localize(
			'frameAI.planReviewCountdown',
			"Auto-approves in {0}s",
			seconds,
		);
	}

	private refreshTools(): void {
		if (!this.toolsBodyEl) {
			return;
		}
		DOM.clearNode(this.toolsBodyEl);

		const current = this.intelligence.tools.getCurrentTool();
		const recent = this.intelligence.tools.getRecentCalls(10);

		DOM.append(this.toolsBodyEl, $('div.frame-ai-tools-current-title', undefined, localize('frameAI.toolsCurrent', "Current")));
		if (current) {
			const currentRow = DOM.append(this.toolsBodyEl, $('.frame-ai-tool-call.is-current'));
			DOM.append(currentRow, $('div.frame-ai-tool-call-name', undefined, current.tool));
			DOM.append(currentRow, $('div.frame-ai-tool-call-meta', undefined, localize(
				'frameAI.toolsRunning',
				"Running · started {0}",
				formatTimestamp(current.startedAt),
			)));
		} else {
			DOM.append(this.toolsBodyEl, $('p.frame-ai-empty', undefined, localize('frameAI.toolsIdle', "Idle")));
		}

		DOM.append(this.toolsBodyEl, $('div.frame-ai-tools-recent-title', undefined, localize('frameAI.toolsRecent', "Recent")));
		if (!recent.length) {
			DOM.append(this.toolsBodyEl, $('p.frame-ai-empty', undefined, localize('frameAI.toolsRecentEmpty', "No tool calls yet.")));
			return;
		}
		const list = DOM.append(this.toolsBodyEl, $('.frame-ai-tools-list'));
		for (const entry of recent) {
			const row = DOM.append(list, $('.frame-ai-tool-call'));
			DOM.append(row, $('div.frame-ai-tool-call-name', undefined, entry.tool));
			DOM.append(row, $('div.frame-ai-tool-call-meta', undefined, localize(
				'frameAI.toolsEntryMeta',
				"{0} · {1}",
				entry.status,
				entry.durationMs !== undefined ? `${entry.durationMs}ms` : '—',
			)));
			if (entry.error) {
				DOM.append(row, $('div.frame-ai-tool-call-error', undefined, entry.error));
			}
		}
	}

	private refreshEdits(): void {
		if (!this.editsBodyEl) {
			return;
		}
		DOM.clearNode(this.editsBodyEl);
		this.editsActions.clear();

		const plan = this.intelligence.workspaceEdits.getPendingPlan();
		const preview = this.intelligence.workspaceEdits.getPreview();
		if (!plan) {
			DOM.append(this.editsBodyEl, $('p.frame-ai-empty', undefined, localize(
				'frameAI.editsEmpty',
				"No pending edit plan.",
			)));
			return;
		}

		const pendingOps = plan.operations.filter(o => o.status === 'pending' || o.status === 'accepted');
		const isStubOrEmpty = plan.stub || plan.operations.length === 0;
		const allResolved = plan.operations.length > 0 && pendingOps.length === 0;
		const someApplied = plan.operations.some(o => o.status === 'applied');
		const canAccept = !isStubOrEmpty && pendingOps.length > 0;

		if (isStubOrEmpty) {
			DOM.append(this.editsBodyEl, $('p.frame-ai-edits-stub', undefined, plan.summary || FRAME_STUB_PLAN_MESSAGE));
			this.appendRows(this.editsBodyEl, [
				[localize('frameAI.editsStatus', "Status"), plan.status],
				[localize('frameAI.editsStub', "Stub"), localize('frameAI.yes', "YES")],
			]);
			const stubActions = DOM.append(this.editsBodyEl, $('.frame-ai-edits-actions'));
			this.addStoreAction(this.editsActions, stubActions, localize('frameAI.editsReject', "Reject"), false, () => {
				void this.intelligence.workspaceEdits.rejectAll().then(() => {
					this.setStatus(localize('frameAI.editsRejected', "Edit plan rejected."));
					this.refreshEdits();
				});
			});
			return;
		}

		if (allResolved) {
			DOM.append(this.editsBodyEl, $('p.frame-ai-edits-applied', undefined, someApplied
				? localize('frameAI.editsAppliedViaChat', "Applied via Chat")
				: localize('frameAI.editsNoPending', "No pending changes")));
		}

		DOM.append(this.editsBodyEl, $('div.frame-ai-edits-summary', undefined, preview?.summary ?? plan.summary));
		this.appendRows(this.editsBodyEl, [
			[localize('frameAI.editsStatus', "Status"), plan.status],
			[localize('frameAI.editsOps', "Operations"), String(plan.operations.length)],
			[localize('frameAI.editsStub', "Stub"), plan.stub ? localize('frameAI.yes', "YES") : localize('frameAI.no', "NO")],
			[localize('frameAI.editsDiff', "+/−"), preview
				? `+${preview.totalAdditions} / −${preview.totalDeletions}`
				: '—'],
		]);

		if (preview?.files.length) {
			const list = DOM.append(this.editsBodyEl, $('.frame-ai-edits-list'));
			for (const file of preview.files.slice(0, 8)) {
				const row = DOM.append(list, $('.frame-ai-edit-file'));
				DOM.append(row, $('div.frame-ai-edit-file-path', undefined, file.path));
				DOM.append(row, $('div.frame-ai-edit-file-meta', undefined, `${file.kind} · ${file.status} · +${file.additions}/−${file.deletions}`));
			}
		}

		const actions = DOM.append(this.editsBodyEl, $('.frame-ai-edits-actions'));
		if (canAccept) {
			this.addStoreAction(this.editsActions, actions, localize('frameAI.editsAccept', "Accept"), true, () => {
				void this.intelligence.workspaceEdits.acceptAll().then(result => {
					this.setStatus(result.message);
					this.refreshEdits();
				});
			});
		}
		if (canAccept) {
			this.addStoreAction(this.editsActions, actions, localize('frameAI.editsReject', "Reject"), false, () => {
				void this.intelligence.workspaceEdits.rejectAll().then(() => {
					this.setStatus(localize('frameAI.editsRejected', "Edit plan rejected."));
					this.refreshEdits();
				});
			});
		}
		this.addStoreAction(this.editsActions, actions, localize('frameAI.editsUndo', "Undo last apply"), false, () => {
			void this.intelligence.workspaceEdits.undoLastApply().then(undone => {
				this.setStatus(undone
					? localize('frameAI.editsUndone', "Last applied edit was restored.")
					: localize('frameAI.editsNothingToUndo', "No applied Frame edit is available to undo."));
				this.refreshEdits();
			});
		});
	}

	private refreshBackground(): void {
		if (!this.backgroundBodyEl) {
			return;
		}
		DOM.clearNode(this.backgroundBodyEl);
		this.backgroundActions.clear();

		const status = this.intelligence.background.getStatus();
		this.appendRows(this.backgroundBodyEl, [
			[localize('frameAI.backgroundRunning', "Running"), status.running ? localize('frameAI.yes', "YES") : localize('frameAI.no', "NO")],
			[localize('frameAI.backgroundLastRun', "Last run"), formatTimestamp(status.lastRunAt)],
			[localize('frameAI.backgroundLastAction', "Last action"), status.lastAction ?? '—'],
		]);

		const actions = DOM.append(this.backgroundBodyEl, $('.frame-ai-knowledge-actions'));
		const runBtnLabel = localize('frameAI.backgroundRun', "Run idle pass");
		this.addStoreAction(this.backgroundActions, actions, runBtnLabel, true, () => {
			void this.intelligence.background.runIdlePass().then(() => {
				this.setStatus(localize('frameAI.backgroundRan', "Idle pass finished."));
				this.refreshBackground();
				this.refreshKnowledge();
				this.refreshLearning();
			}, err => {
				this.setStatus(localize('frameAI.backgroundFail', "Idle pass failed: {0}", String(err)));
				this.refreshBackground();
			});
		});
	}

	private refreshTraining(): void {
		if (!this.trainingBodyEl) {
			return;
		}
		DOM.clearNode(this.trainingBodyEl);
		this.trainingActions.clear();

		const probe = this.intelligence.training.getLastProbe();
		const estimate = this.intelligence.training.getLastEstimate();
		const jobs = this.pickTrainingJobsForDisplay(this.intelligence.training.listJobs());

		// Compact readiness line — no redundant Yes/No rows.
		if (probe) {
			const ready = probe.mlxAvailable && probe.backend === 'mlx_gpu';
			DOM.append(this.trainingBodyEl, $('p.frame-ai-train-ready', undefined, ready
				? localize('frameAI.trainReadyOk', "Ready · MLX Metal GPU")
				: localize('frameAI.trainReadyWarn', "Not ready · {0}", probe.reason || (probe.backend === 'cpu' ? 'CPU fallback' : 'MLX missing'))));
		} else {
			DOM.append(this.trainingBodyEl, $('p.frame-ai-empty', undefined, localize('frameAI.trainProbing', "Checking MLX…")));
		}

		if (estimate) {
			DOM.append(this.trainingBodyEl, $('p.frame-ai-train-estimate', undefined, localize(
				'frameAI.trainEstimateLine',
				"Last estimate: ~{0}h · ~{1} GB RAM · {2} train rows · {3} iters",
				estimate.estimatedDurationHours,
				estimate.estimatedRamGb,
				estimate.trainRows.toLocaleString(),
				estimate.iters,
			)));
		}

		const actions = DOM.append(this.trainingBodyEl, $('.frame-ai-adapter-import-actions'));
		this.addStoreAction(this.trainingActions, actions, localize('frameAI.trainEstimate', "Estimate"), false, () => {
			void this.intelligence.training.estimate({ iters: 1200 }).then(est => {
				this.setStatus(localize(
					'frameAI.trainEstimateOk',
					"Estimate: ~{0}h on {1}, ~{2} GB RAM.",
					est.estimatedDurationHours,
					est.backend === 'mlx_gpu' ? 'MLX GPU' : 'CPU',
					est.estimatedRamGb,
				));
				this.refreshTraining();
			}, err => this.setStatus(localize('frameAI.trainErr', "Training error: {0}", String(err))));
		});
		this.addStoreAction(this.trainingActions, actions, localize('frameAI.trainStart', "Start"), true, () => {
			void this.onStartTraining(false);
		});
		this.addStoreAction(this.trainingActions, actions, localize('frameAI.trainOvernight', "Overnight"), false, () => {
			void this.onStartTraining(true);
		});

		if (!jobs.length) {
			DOM.append(this.trainingBodyEl, $('p.frame-ai-empty', undefined, localize(
				'frameAI.trainEmpty',
				"No active jobs. Start here, or run ./scripts/run_managed_train.sh in the terminal.",
			)));
			return;
		}

		for (const job of jobs) {
			this.renderTrainingJob(job);
		}
	}

	/** Active jobs first; at most one recent finished job. Skip old cancelled noise. */
	private pickTrainingJobsForDisplay(all: readonly IFrameTrainingJob[]): IFrameTrainingJob[] {
		const activeStatuses = new Set<FrameTrainingJobStatus>([
			FrameTrainingJobStatus.Running,
			FrameTrainingJobStatus.Paused,
			FrameTrainingJobStatus.Scheduled,
			FrameTrainingJobStatus.Queued,
			FrameTrainingJobStatus.Draft,
		]);
		const sorted = [...all].sort((a, b) => b.updatedAt - a.updatedAt);
		const active = sorted.filter(j => activeStatuses.has(j.status));
		const finished = sorted.find(j =>
			j.status === FrameTrainingJobStatus.Succeeded
			|| j.status === FrameTrainingJobStatus.Failed
			|| j.status === FrameTrainingJobStatus.Cancelled
		);
		const out = [...active];
		if (finished && !out.some(j => j.id === finished.id)) {
			out.push(finished);
		}
		return out.slice(0, 3);
	}

	private renderTrainingJob(job: IFrameTrainingJob): void {
		const card = DOM.append(this.trainingBodyEl, $('.frame-ai-train-job'));
		if (job.status === FrameTrainingJobStatus.Running) {
			card.classList.add('running');
		}

		DOM.append(card, $('div.frame-ai-train-job-title', undefined, job.name || job.id));
		DOM.append(card, $('div.frame-ai-train-job-status', undefined, formatTrainingStatus(job)));

		const pct = Math.max(0, Math.min(100, Math.round((job.progress ?? 0) * 100)));
		const bar = DOM.append(card, $('.frame-ai-train-progress'));
		const fill = DOM.append(bar, $('.frame-ai-train-progress-fill')) as HTMLElement;
		fill.style.width = `${pct}%`;

		const bits: string[] = [];
		if (job.iters) {
			bits.push(localize('frameAI.trainJobIters', "{0} iters", job.iters));
		}
		if (job.adapterPath) {
			bits.push(basenamePath(job.adapterPath));
		}
		if (job.pid) {
			bits.push(`pid ${job.pid}`);
		}
		if (bits.length) {
			DOM.append(card, $('div.frame-ai-train-job-meta', undefined, bits.join(' · ')));
		}
		if (job.error) {
			DOM.append(card, $('p.frame-ai-train-job-error', undefined, job.error));
		}

		const row = DOM.append(card, $('.frame-ai-adapter-import-actions'));
		if (job.status === FrameTrainingJobStatus.Running) {
			this.addStoreAction(this.trainingActions, row, localize('frameAI.trainPause', "Pause"), false, () => {
				void this.intelligence.training.pause(job.id).then(() => this.refreshTraining());
			});
		}
		if (job.status === FrameTrainingJobStatus.Paused) {
			this.addStoreAction(this.trainingActions, row, localize('frameAI.trainResume', "Resume"), true, () => {
				void this.intelligence.training.resume(job.id).then(() => this.refreshTraining());
			});
		}
		if (job.status === FrameTrainingJobStatus.Running
			|| job.status === FrameTrainingJobStatus.Paused
			|| job.status === FrameTrainingJobStatus.Scheduled
			|| job.status === FrameTrainingJobStatus.Draft
			|| job.status === FrameTrainingJobStatus.Queued) {
			this.addStoreAction(this.trainingActions, row, localize('frameAI.trainCancel', "Cancel"), false, () => {
				void this.intelligence.training.cancel(job.id).then(() => this.refreshTraining());
			});
		}
	}

	private async onStartTraining(overnight: boolean): Promise<void> {
		try {
			const estimate = await this.intelligence.training.estimate({ iters: 1200 });
			this.setStatus(localize(
				'frameAI.trainStarting',
				"Starting LoRA train: ~{0}h · {1} · ~{2} GB RAM",
				estimate.estimatedDurationHours,
				estimate.backend === 'mlx_gpu' ? 'MLX GPU' : 'CPU',
				estimate.estimatedRamGb,
			));
			const job = await this.intelligence.training.createJob({
				name: 'Frame agent LoRA v1',
				baseModelId: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit',
				options: {
					iters: 1200,
					scheduleAt: overnight ? 'overnight' : undefined,
					cpuLimit: estimate.backend === 'cpu',
				},
			});
			const started = await this.intelligence.training.start(job.id, {
				iters: 1200,
				scheduleAt: overnight ? 'overnight' : undefined,
				cpuLimit: estimate.backend === 'cpu',
			});
			this.setStatus(started
				? localize('frameAI.trainStarted', "Training {0} — {1}.", started.status, started.id)
				: localize('frameAI.trainStartFail', "Could not start training. Check .venv-lora / MLX setup."));
			this.refreshTraining();
		} catch (err) {
			this.setStatus(localize('frameAI.trainErr', "Training error: {0}", String(err)));
		}
	}

	private refreshAdapters(): void {
		if (!this.adaptersBodyEl) {
			return;
		}
		DOM.clearNode(this.adaptersBodyEl);
		const groups = this.intelligence.adapterManagement.getGroupedAdapters();
		if (!groups.active.length && !groups.available.length && !groups.imported.length) {
			DOM.append(this.adaptersBodyEl, $('p.frame-ai-empty', undefined, localize(
				'frameAI.adaptersEmpty',
				"No adapters yet. Drop a .gguf / .safetensors file above, or import package JSON.",
			)));
			return;
		}
		this.renderAdapterGroup(localize('frameAI.adaptersActive', "Active on model"), groups.active, true);
		this.renderAdapterGroup(localize('frameAI.adaptersAvailable', "Available"), groups.available, false);
		this.renderAdapterGroup(localize('frameAI.adaptersImported', "Imported"), groups.imported, false);
	}

	private renderAdapterGroup(title: string, items: readonly IFrameAdapterListItem[], isActiveGroup: boolean): void {
		const group = DOM.append(this.adaptersBodyEl, $('.frame-ai-adapter-group'));
		DOM.append(group, $('h4.frame-ai-adapter-group-title', undefined, `${title} (${items.length})`));
		if (!items.length) {
			DOM.append(group, $('p.frame-ai-adapter-group-empty', undefined, isActiveGroup
				? localize('frameAI.adapterActiveEmpty', "None active — activate an adapter with linked weights to load it with the model.")
				: localize('frameAI.adapterGroupEmpty', "None")));
			return;
		}
		const list = DOM.append(group, $('.frame-ai-adapter-list'));
		for (const item of items) {
			this.renderAdapterCard(list, item);
		}
	}

	private renderAdapterCard(parent: HTMLElement, item: IFrameAdapterListItem): void {
		const { descriptor, compatible, imported, weightsLinked, weightBytes, storagePath } = item;
		const builtin = isFrameBuiltinAdapter(descriptor);
		const card = DOM.append(parent, $('.frame-ai-adapter-card'));
		if (descriptor.state === FrameAdapterState.Active) {
			card.classList.add('active');
		}
		if (builtin) {
			card.classList.add('builtin');
		}
		const title = descriptor.name || descriptor.weightFileName || descriptor.id;
		DOM.append(card, $('div.frame-ai-adapter-name', undefined, title));
		DOM.append(card, $('div.frame-ai-adapter-scope', undefined, builtin
			? localize('frameAI.adapterBuiltinBadge', "Built-in · always on")
			: scopeLabel(descriptor.scope)));

		const weightStatus = weightsLinked
			? localize('frameAI.adapterWeightsLinked', "Weights: linked ({0})", formatBytes(weightBytes))
			: builtin
				? localize('frameAI.adapterBuiltinWeightsPending', "Weights: waiting for shipped GGUF (metadata registered)")
				: localize('frameAI.adapterWeightsMissing', "Weights: metadata only — drop/browse a file");
		DOM.append(card, $('div.frame-ai-adapter-meta', undefined, localize(
			'frameAI.adapterStatusLine',
			"Status: {0} · {1} · Compatible: {2}{3}",
			descriptor.state,
			weightStatus,
			compatible ? localize('frameAI.yes', "YES") : localize('frameAI.no', "NO"),
			imported ? ` · ${localize('frameAI.adapterImportedBadge', "Imported")}` : '',
		)));
		if (storagePath) {
			DOM.append(card, $('div.frame-ai-adapter-path', undefined, storagePath));
		}

		const actions = DOM.append(card, $('.frame-ai-adapter-actions'));
		const isActive = descriptor.state === FrameAdapterState.Active;
		if (!builtin) {
			this.addAction(actions, isActive ? localize('frameAI.adapterDeactivate', "Deactivate") : localize('frameAI.adapterActivate', "Activate"), !isActive, () => {
				void (isActive
					? this.intelligence.adapterManagement.deactivate(descriptor.id)
					: this.intelligence.adapterManagement.activate(descriptor.id)
				).then(() => this.refreshAdapters());
			});
		}
		this.addAction(actions, localize('frameAI.adapterExportWeights', "Export file…"), false, () => void this.onExportWeights(descriptor.id, descriptor.weightFileName));
		this.addAction(actions, localize('frameAI.adapterCopyPackage', "Copy JSON"), false, () => this.onExport(descriptor.id));
		this.addAction(actions, localize('frameAI.adapterReveal', "Reveal"), false, () => void this.onRevealAdapter(descriptor.id));
		this.addAction(actions, localize('frameAI.adapterDetails', "Details"), false, () => {
			this.expandedAdapterId = this.expandedAdapterId === descriptor.id ? undefined : descriptor.id;
			this.refreshAdapters();
		});
		if (!builtin) {
			this.addAction(actions, localize('frameAI.adapterRemove', "Remove"), false, () => {
				void this.intelligence.adapterManagement.remove(descriptor.id).then(() => this.refreshAdapters());
			});
		}

		if (this.expandedAdapterId === descriptor.id) {
			const detailsEl = DOM.append(card, $('.frame-ai-adapter-details'));
			DOM.append(detailsEl, $('p', undefined, localize('frameAI.adapterDetailsLoading', "Loading details…")));
			void this.intelligence.adapterManagement.getDetails(descriptor.id).then(details => {
				DOM.clearNode(detailsEl);
				if (!details) {
					DOM.append(detailsEl, $('p', undefined, localize('frameAI.adapterDetailsMiss', "Adapter not found.")));
					return;
				}
				DOM.append(detailsEl, $('div', undefined, `${details.metadata.name} · ${details.metadata.baseModel}`));
				DOM.append(detailsEl, $('div', undefined, details.metadata.description ?? ''));
				if (builtin) {
					DOM.append(detailsEl, $('div', undefined, localize(
						'frameAI.adapterBuiltinDetails',
						"Product foundation LoRA — shipped with Frame and always applied when adapters.gguf is present.",
					)));
				}
				DOM.append(detailsEl, $('div', undefined, details.weightsLinked
					? localize('frameAI.adapterDetailsWeights', "Weight file: {0} ({1})", details.weightAbsolutePath ?? details.descriptor.weightFileName ?? '—', formatBytes(details.weightBytes))
					: localize('frameAI.adapterDetailsNoWeights', "No weight file on disk yet. Use Browse or drop a .gguf above (Link to selected while expanded).")));
				DOM.append(detailsEl, $('div', undefined, localize('frameAI.adapterDetailsFolder', "Folder: {0}", details.descriptor.localPath ?? `.frame/adapters/${details.descriptor.id}`)));
			});
		}
	}

	private addAction(parent: HTMLElement, label: string, primary: boolean, onClick: () => void): void {
		const btn = DOM.append(parent, $(primary ? 'button.frame-ai-gen-action' : 'button.frame-ai-gen-action.secondary')) as HTMLButtonElement;
		btn.type = 'button';
		btn.textContent = label;
		this._register(DOM.addDisposableListener(btn, 'click', onClick));
	}

	private addStoreAction(store: DisposableStore, parent: HTMLElement, label: string, primary: boolean, onClick: () => void): void {
		const btn = DOM.append(parent, $(primary ? 'button.frame-ai-gen-action' : 'button.frame-ai-gen-action.secondary')) as HTMLButtonElement;
		btn.type = 'button';
		btn.textContent = label;
		store.add(DOM.addDisposableListener(btn, 'click', onClick));
	}

	private onValidatePackage(): void {
		const result = this.intelligence.adapterManagement.validatePackageJson(this.importInputEl.value);
		if (result.ok && result.pkg) {
			this.setStatus(localize(
				'frameAI.adapterValidateOk',
				"Valid: {0} v{1} ({2})",
				result.pkg.metadata.name,
				result.pkg.metadata.version,
				result.pkg.metadata.scope,
			));
		} else {
			this.setStatus(localize('frameAI.adapterValidateFail', "Invalid package: {0}", result.errors.join('; ') || 'unknown'));
		}
	}

	private onImportPackage(): void {
		void this.intelligence.adapterManagement.importPackageJson(this.importInputEl.value).then(desc => {
			this.importInputEl.value = '';
			this.lastImportedAdapterId = desc.id;
			this.expandedAdapterId = desc.id;
			this.setStatus(localize('frameAI.adapterImportOk', "Imported “{0}”. Drop or Browse a weight file (Link to selected) to attach LoRA bytes.", desc.name ?? desc.id));
			this.refreshAdapters();
		}, err => {
			this.setStatus(localize('frameAI.adapterImportFail', "Import failed: {0}", String(err)));
		});
	}

	private async onBrowseWeightFile(options: { asNew: boolean }): Promise<void> {
		const defaultUri = await this.fileDialogService.defaultFilePath();
		const result = await this.fileDialogService.showOpenDialog({
			title: localize('frameAI.adapterBrowseTitle', "Select LoRA weight file"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			openLabel: options.asNew
				? localize('frameAI.adapterBrowseOpenNew', "Import")
				: localize('frameAI.adapterBrowseOpenLink', "Link"),
			defaultUri,
			filters: [
				{ name: 'LoRA weights', extensions: ['gguf', 'safetensors'] },
				{ name: 'All Files', extensions: ['*'] },
			],
		});
		const path = result?.[0]?.fsPath;
		if (!path) {
			return;
		}
		await this.onImportWeightPath(path, { asNew: options.asNew, activate: options.asNew });
	}

	private async onImportWeightPath(path: string, options: { asNew: boolean; activate?: boolean }): Promise<void> {
		try {
			if (options.asNew) {
				const desc = await this.intelligence.adapterManagement.importWeightAsAdapter(path, { activate: options.activate });
				this.lastImportedAdapterId = desc.id;
				this.expandedAdapterId = desc.id;
				this.setStatus(localize(
					'frameAI.adapterWeightImportOk',
					"Imported “{0}” → {1} ({2})",
					desc.name ?? desc.id,
					desc.weightFileName ?? path,
					desc.localPath ?? `.frame/adapters/${desc.id}`,
				));
				this.refreshAdapters();
				return;
			}
			const adapterId = this.expandedAdapterId ?? this.lastImportedAdapterId;
			if (!adapterId) {
				this.setStatus(localize('frameAI.adapterWeightNeedTarget', "Expand an adapter’s Details first, or use Browse to create a new adapter."));
				return;
			}
			const desc = await this.intelligence.adapterManagement.importWeightFile(adapterId, path);
			if (!desc) {
				this.setStatus(localize('frameAI.adapterWeightFail', "Could not link weights for {0}.", adapterId));
				return;
			}
			this.setStatus(localize(
				'frameAI.adapterWeightOk',
				"Linked weights for “{0}” → {1}",
				desc.name ?? desc.id,
				desc.weightFileName ?? path,
			));
			this.refreshAdapters();
		} catch (err) {
			this.setStatus(localize('frameAI.adapterWeightErr', "Weight import failed: {0}", String(err)));
		}
	}

	private async onExportWeights(id: string, weightFileName?: string): Promise<void> {
		const linkedPath = await this.intelligence.adapterManagement.resolveWeightPath(id);
		if (!linkedPath) {
			this.setStatus(localize('frameAI.adapterExportWeightsMissing', "No weight file on disk for this adapter. Import or link a .gguf first."));
			return;
		}
		const defaultName = weightFileName || linkedPath.split(/[/\\]/).pop() || 'adapter.gguf';
		const defaultUri = URI.joinPath(await this.fileDialogService.defaultFilePath(), defaultName);
		const dest = await this.fileDialogService.showSaveDialog({
			title: localize('frameAI.adapterExportWeightsTitle', "Export LoRA weight file"),
			saveLabel: localize('frameAI.adapterExportWeightsSave', "Export"),
			defaultUri,
			filters: [
				{ name: 'LoRA weights', extensions: ['gguf', 'safetensors'] },
				{ name: 'All Files', extensions: ['*'] },
			],
		});
		if (!dest) {
			return;
		}
		try {
			const exported = await this.intelligence.adapterManagement.exportWeightFile(id, dest.fsPath);
			this.setStatus(localize('frameAI.adapterExportWeightsOk', "Exported weights to {0}", exported));
		} catch (err) {
			this.setStatus(localize('frameAI.adapterExportWeightsFail', "Export failed: {0}", String(err)));
		}
	}

	private async onRevealAdapter(id: string): Promise<void> {
		const path = await this.intelligence.adapterManagement.resolveWeightPath(id);
		const target = path ?? (await this.intelligence.adapters.getAdapter(id))?.localPath;
		if (path) {
			try {
				await this.commandService.executeCommand('revealFileInOS', URI.file(path));
				this.setStatus(localize('frameAI.adapterRevealOk', "Revealed {0}", path));
				return;
			} catch {
				// fall through
			}
		}
		this.setStatus(localize(
			'frameAI.adapterRevealHint',
			"Adapter folder: {0} (open in Finder from the workspace). Weight: {1}",
			target ?? `.frame/adapters/${id}`,
			path ?? localize('frameAI.none', "none"),
		));
	}

	private onExport(id: string): void {
		void this.intelligence.adapterManagement.exportAdapter(id).then(async pkg => {
			if (!pkg) {
				this.setStatus(localize('frameAI.adapterExportMiss', "Could not export adapter."));
				return;
			}
			await this.clipboardService.writeText(JSON.stringify(pkg, null, 2));
			this.setStatus(pkg.hasWeights
				? localize('frameAI.adapterExportOkWithWeights', "Copied “{0}” metadata JSON. Use Export file… for the LoRA weights.", pkg.metadata.name)
				: localize('frameAI.adapterExportOk', "Copied “{0}” metadata JSON (no weight file linked yet).", pkg.metadata.name));
		});
	}

	private appendRows(parent: HTMLElement, rows: Array<[string, string]>): void {
		for (const [label, value] of rows) {
			const row = DOM.append(parent, $('.frame-ai-stat-row'));
			DOM.append(row, $('span.frame-ai-stat-label', undefined, label));
			DOM.append(row, $('span.frame-ai-stat-value', undefined, value));
		}
	}

	private setStatus(text: string): void {
		if (this.statusEl) {
			this.statusEl.textContent = text;
		}
	}
}

function formatGpu(hw: IFrameHardwareProfile): string {
	if (!hw.gpuAvailable) {
		return localize('frameAI.noGpu', "None");
	}
	const name = hw.gpuName ?? localize('frameAI.gpuPresent', "Available");
	return hw.gpuMemoryGB !== undefined ? `${name} (${hw.gpuMemoryGB} GB)` : name;
}

function formatRuntime(status: IFrameRuntimeStatus): string {
	const active = status.available.find(r => r.id === status.activeRuntimeId);
	return `${active?.displayName ?? status.activeKind}${status.enabled ? '' : ' (disabled)'}`;
}

function formatMb(value: number | null | undefined): string {
	if (value === null || value === undefined) {
		return '—';
	}
	return `${Math.round(value)} MB`;
}

function formatTimestamp(value: number | null | undefined): string {
	if (value === null || value === undefined) {
		return '—';
	}
	try {
		return new Date(value).toLocaleString();
	} catch {
		return String(value);
	}
}

function scopeLabel(scope: FrameAdapterScope): string {
	switch (scope) {
		case FrameAdapterScope.Language:
			return localize('frameAI.scopeLanguage', "Language Adapter");
		case FrameAdapterScope.Project:
			return localize('frameAI.scopeProject', "Project Adapter");
		case FrameAdapterScope.User:
			return localize('frameAI.scopeUser', "User Preference Adapter");
		default:
			return String(scope);
	}
}

function formatBytes(value: number | undefined): string {
	if (value === undefined || value < 0) {
		return '—';
	}
	if (value < 1024) {
		return `${value} B`;
	}
	if (value < 1024 * 1024) {
		return `${(value / 1024).toFixed(1)} KB`;
	}
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function extractDroppedFilePath(e: DragEvent): string | undefined {
	const files = e.dataTransfer?.files;
	if (files && files.length > 0) {
		const file = files[0] as File & { path?: string };
		if (typeof file.path === 'string' && file.path.trim()) {
			return file.path.trim();
		}
	}
	const uriList = e.dataTransfer?.getData('text/uri-list')?.trim();
	if (uriList) {
		const first = uriList.split(/\r?\n/).find(line => line && !line.startsWith('#'));
		if (first) {
			try {
				const uri = URI.parse(first.trim());
				if (uri.scheme === 'file') {
					return uri.fsPath;
				}
			} catch {
				// ignore
			}
		}
	}
	return undefined;
}

function basenamePath(path: string): string {
	const parts = path.replace(/\\/g, '/').split('/');
	return parts[parts.length - 1] || path;
}

function formatTrainingStatus(job: IFrameTrainingJob): string {
	const pct = Math.max(0, Math.min(100, Math.round((job.progress ?? 0) * 100)));
	const backend = job.backend === 'mlx_gpu' ? 'MLX GPU' : job.backend === 'cpu' ? 'CPU' : '';
	let label: string;
	switch (job.status) {
		case FrameTrainingJobStatus.Running:
			label = localize('frameAI.trainStatusRunning', "Running");
			break;
		case FrameTrainingJobStatus.Paused:
			label = localize('frameAI.trainStatusPaused', "Paused");
			break;
		case FrameTrainingJobStatus.Scheduled:
			label = localize('frameAI.trainStatusScheduled', "Scheduled");
			break;
		case FrameTrainingJobStatus.Succeeded:
			label = localize('frameAI.trainStatusDone', "Succeeded");
			break;
		case FrameTrainingJobStatus.Failed:
			label = localize('frameAI.trainStatusFailed', "Failed");
			break;
		case FrameTrainingJobStatus.Cancelled:
			label = localize('frameAI.trainStatusCancelled', "Cancelled");
			break;
		case FrameTrainingJobStatus.Queued:
			label = localize('frameAI.trainStatusQueued', "Queued");
			break;
		default:
			label = String(job.status);
	}
	const parts = [label, `${pct}%`];
	if (backend) {
		parts.push(backend);
	}
	return parts.join(' · ');
}

export const frameAIViewName = localize2('frameAI.viewName', "Frame");
