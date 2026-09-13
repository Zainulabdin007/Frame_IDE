/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { ChatMode } from '../../chat/common/chatModes.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import { IChatProgress } from '../../chat/common/chatService/chatService.js';
import { IChatAgentHistoryEntry, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../../chat/common/participants/chatAgents.js';
import { isChatRequestFileEntry, isPromptFileVariableEntry, type IChatRequestVariableEntry } from '../../chat/common/attachments/chatVariableEntries.js';
import { FrameMessageRole, FrameTaskKind, FrameTaskStatus, IFrameChatMessage } from '../common/models.js';
import { IFrameWorkspaceEditService } from '../editing/frameWorkspaceEditService.js';
import { stripFrameControlFences } from '../runtime/frameEditPlan.js';
import { IFrameIntelligenceService } from '../services/frameIntelligence.js';

const MAX_HISTORY_TURNS = 4;

function historyToFrameMessages(history: readonly IChatAgentHistoryEntry[]): IFrameChatMessage[] {
	const messages: IFrameChatMessage[] = [];
	const recent = history.slice(-MAX_HISTORY_TURNS);
	// Chat history entries carry no real timestamps, so derive stable monotonic
	// ones from the entry index (strictly before "now") to preserve turn ordering
	// for consumers that sort by createdAt.
	const base = Date.now() - recent.length * 2 - 1;
	for (let i = 0; i < recent.length; i++) {
		const entry = recent[i];
		const prompt = (entry.request.message || '').trim();
		if (prompt) {
			messages.push({
				id: generateUuid(),
				role: FrameMessageRole.User,
				content: prompt,
				createdAt: base + i * 2,
			});
		}
		const responseText = entry.response
			.filter((part): part is { kind: 'markdownContent'; content: MarkdownString } => part.kind === 'markdownContent')
			.map(part => part.content.value)
			.join('')
			.trim();
		if (responseText) {
			messages.push({
				id: generateUuid(),
				role: FrameMessageRole.Assistant,
				content: responseText,
				createdAt: base + i * 2 + 1,
			});
		}
	}
	return messages;
}

/** Pull file URIs from Chat attachments / #file / implicit context. */
function collectAttachedFileUris(request: IChatAgentRequest): URI[] {
	const out: URI[] = [];
	const seen = new Set<string>();
	const push = (uri: URI | undefined) => {
		if (!uri || uri.scheme !== 'file') {
			return;
		}
		const key = uri.toString();
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		out.push(uri);
	};

	const variables = request.variables?.variables ?? [];
	for (const entry of variables) {
		push(uriFromVariableEntry(entry));
	}
	return out;
}

function uriFromVariableEntry(entry: IChatRequestVariableEntry): URI | undefined {
	if (isChatRequestFileEntry(entry) || isPromptFileVariableEntry(entry)) {
		return uriFromVariableValue(entry.value);
	}
	if (entry.kind === 'implicit' && (entry as { isFile?: boolean }).isFile) {
		const implicit = entry as { uri?: URI; value?: unknown };
		if (URI.isUri(implicit.uri)) {
			return implicit.uri;
		}
		return uriFromVariableValue(implicit.value);
	}
	if (entry.kind === 'directory') {
		return uriFromVariableValue(entry.value);
	}
	return uriFromVariableValue((entry as { value?: unknown }).value);
}

function uriFromVariableValue(value: unknown): URI | undefined {
	if (URI.isUri(value)) {
		return value;
	}
	if (value && typeof value === 'object') {
		const loc = value as { uri?: unknown };
		if (URI.isUri(loc.uri)) {
			return loc.uri;
		}
	}
	return undefined;
}

function buildPromptWithAttachments(message: string, attached: readonly URI[], workspaceFolders: readonly URI[]): string {
	const trimmed = message.trim();
	if (!attached.length) {
		return trimmed;
	}
	const lines = attached.map(uri => {
		const folder = workspaceFolders.find(root => uri.path === root.path || uri.path.startsWith(`${root.path.replace(/\/$/, '')}/`));
		const path = folder ? uri.path.slice(folder.path.replace(/\/$/, '').length + 1) : uri.path.split('/').pop() ?? uri.path;
		return `- ${path}`;
	});
	const block = `Attached files:\n${lines.join('\n')}`;
	if (!trimmed) {
		return `Describe what the attached file(s) are about.\n\n${block}`;
	}
	return `${trimmed}\n\n${block}`;
}

/**
 * Default Chat agent for the right-side Chat panel.
 * Routes every message to Frame Intelligence (orchestrator → worker).
 */
export class FrameChatAgent extends Disposable implements IChatAgentImplementation {

	/**
	 * Registers Frame as the preferred default agent for Chat / inline locations.
	 * Uses isCore: false so it wins over SetupAgent (core) defaults.
	 */
	static registerDefaultAgents(instantiationService: IInstantiationService): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const chatAgentService = accessor.get(IChatAgentService);
			const store = new DisposableStore();

			const register = (id: string, location: ChatAgentLocation, mode: ChatModeKind, description: string, isDefault: boolean) => {
				store.add(chatAgentService.registerAgent(id, {
					id,
					name: 'Frame',
					isDefault,
					isCore: false,
					modes: [mode],
					slashCommands: [],
					disambiguation: [],
					locations: [location],
					metadata: {
						helpTextPrefix: new MarkdownString(localize(
							'frameChat.help',
							"Frame AI — local-first. Configure hardware, models, and LoRA adapters in the **Frame** sidebar.",
						)),
					},
					description,
					extensionId: nullExtensionDescription.identifier,
					extensionVersion: undefined,
					extensionDisplayName: 'Frame',
					extensionPublisherId: 'frame',
				}));
				const agent = store.add(instantiationService.createInstance(FrameChatAgent));
				store.add(chatAgentService.registerAgentImplementation(id, agent));
				if (mode === ChatModeKind.Agent) {
					chatAgentService.updateAgent(id, { themeIcon: Codicon.sparkle });
				}
			};

			for (const mode of [ChatModeKind.Ask, ChatModeKind.Edit, ChatModeKind.Agent]) {
				const id = mode === ChatModeKind.Ask
					? 'frame.chat'
					: mode === ChatModeKind.Edit
						? 'frame.edits'
						: 'frame.agent';
				const description = (mode === ChatModeKind.Ask
					? ChatMode.Ask.description.get()
					: mode === ChatModeKind.Edit
						? ChatMode.Edit.description.get()
						: ChatMode.Agent.description.get()) ?? localize('frameChat.defaultDesc', "Frame local assistant");
				register(id, ChatAgentLocation.Chat, mode, description, true);
			}

			register('frame.editor', ChatAgentLocation.EditorInline, ChatModeKind.Ask, localize('frameChat.editorDesc', "Frame local assistant"), true);
			register('frame.terminal', ChatAgentLocation.Terminal, ChatModeKind.Ask, localize('frameChat.terminalDesc', "Frame local assistant"), true);
			register('frame.notebook', ChatAgentLocation.Notebook, ChatModeKind.Ask, localize('frameChat.notebookDesc', "Frame local assistant"), true);

			return store;
		});
	}

	constructor(
		@IFrameIntelligenceService private readonly intelligence: IFrameIntelligenceService,
		@IFrameWorkspaceEditService private readonly workspaceEdits: IFrameWorkspaceEditService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		const attached = collectAttachedFileUris(request);
		const workspaceFolders = this.workspaceService.getWorkspace().folders.map(folder => folder.uri);
		const prompt = buildPromptWithAttachments(request.message || '', attached, workspaceFolders);
		if (!prompt) {
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(localize('frameChat.empty', "Send a message to Frame AI.")),
			}]);
			return {};
		}

		this.logService.info(
			`[FrameChat] Submitting to Frame Intelligence attachments=${attached.length}${attached[0] ? ` primary=${attached[0].fsPath}` : ''}`,
		);

		// Stable id up front so Stop can cancel before inference starts.
		const activeTaskId = generateUuid();
		const store = new DisposableStore();

		store.add(token.onCancellationRequested(() => {
			this.intelligence.orchestrator.cancelTask(activeTaskId).catch(err => this.logService.warn('[FrameChat] Failed to cancel task', err));
		}));

		try {
			const sessionId = request.sessionResource?.toString();
			const messages = historyToFrameMessages(history);
			const activeUri = attached[0];
			const kind = request.agentId === 'frame.edits'
				? FrameTaskKind.Edit
				: FrameTaskKind.Chat;
			const result = await this.intelligence.submitTask({
				id: activeTaskId,
				kind,
				prompt,
				sessionId,
				createdAt: Date.now(),
				messages,
				activeUri,
				attachedUris: attached,
			});

			if (token.isCancellationRequested) {
				this.logService.info(`[FrameChat] Cancelled task=${activeTaskId}`);
				return {};
			}

			const output = (result.output || '').trim();
			const err = (result.error || '').trim();
			const failed = result.status === FrameTaskStatus.Failed || !!err;

			// Post the final answer once. Incremental token streaming into Chat was
			// racing taskId/requestId and skipping this path when `streamed` flipped
			// true — the model finished (logs/memory had text) but the bubble stayed
			// on "Analyzing" with no visible reply.
			if (failed) {
				progress([{
					kind: 'warning',
					content: new MarkdownString(localize('frameChat.inferError', "Frame AI error: {0}", err || result.message || 'Inference failed')),
				}]);
			} else if (output) {
				const prose = stripFrameControlFences(output);
				if (prose) {
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(prose),
					}]);
				}
			} else {
				const cfg = this.intelligence.runtimes.getConfig();
				const path = cfg.modelPath;
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(
						path
							? localize(
								'frameChat.emptyOutput',
								"Frame finished without text. Model path is set (`{0}`). Check the Frame sidebar runtime status, then try again.",
								path,
							)
							: localize(
								'frameChat.stubEmpty',
								"Frame received your message. Configure a local model in the Frame sidebar when you are ready — no cloud account required.",
							),
					),
				}]);
			}

			await this.emitEditPlanProgress(result.editPlanId, progress);
			this.logService.info(
				`[FrameChat] Completed task=${activeTaskId} status=${result.status} chars=${output.length}`,
			);

			return {};
		} catch (err) {
			this.logService.error('[FrameChat] Orchestrator error', err);
			progress([{
				kind: 'warning',
				content: new MarkdownString(localize('frameChat.error', "Frame AI error: {0}", String(err))),
			}]);
			return {};
		} finally {
			store.dispose();
		}
	}

	/**
	 * Applies edit plans with operations directly to the workspace.
	 * Empty / stub plans are reported only — nothing to write.
	 */
	private async emitEditPlanProgress(
		editPlanId: string | undefined,
		progress: (parts: IChatProgress[]) => void,
	): Promise<void> {
		const plan = this.workspaceEdits.getPendingPlan();
		if (!editPlanId || !plan || plan.id !== editPlanId) {
			return;
		}

		if (!plan.operations.length || plan.stub) {
			this.logService.info(`[FrameChat] No applyable edit ops (stub=${plan.stub} ops=${plan.operations.length})`);
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(localize(
					'frameChat.stubPlan',
					"No file changes were produced from that reply. Open the target file and ask again with a concrete edit (or a ``` code block).",
				)),
			}]);
			return;
		}

		const validation = this.workspaceEdits.validatePlan(plan);
		if (!validation.ok) {
			// Path / workspace issues only — still try apply below when possible.
			this.logService.warn(`[FrameChat] Edit plan validation issues: ${validation.issues.join('; ')}`);
		}

		const opSummary = plan.operations.map(op => {
			if (op.kind === 'create' || op.kind === 'modify' || op.kind === 'delete') {
				return `- \`${op.kind}\` \`${op.path}\``;
			}
			return `- rename \`${op.fromPath}\` → \`${op.toPath}\``;
		}).join('\n');

		progress([{
			kind: 'markdownContent',
			content: new MarkdownString([
				localize('frameChat.planApplyingTitle', "**Applying edits:** {0}", plan.summary),
				opSummary,
			].join('\n\n')),
		}]);

		const result = await this.workspaceEdits.acceptAll();
		if (result.ok) {
			this.logService.info(`[FrameChat] Auto-applied plan ${plan.id} (${result.appliedOperationIds.length} op(s))`);
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(localize(
					'frameChat.planApplied',
					"Applied {0} file change(s). Check the open editor tab — the buffer is updated and saved.",
					result.appliedOperationIds.length,
				)),
			}]);
			return;
		}

		this.logService.warn(`[FrameChat] Auto-apply failed for ${plan.id}: ${result.message}`);
		progress([{
			kind: 'warning',
			content: new MarkdownString(localize(
				'frameChat.planApplyFailed',
				"Could not apply the edit plan automatically: {0}",
				result.message || 'unknown error',
			)),
		}]);
	}
}
