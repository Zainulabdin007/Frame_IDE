/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableSource } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import {
	ChatMessageRole,
	IChatMessage,
	IChatResponsePart,
	ILanguageModelChatInfoOptions,
	ILanguageModelChatMetadata,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatResponse,
} from '../../chat/common/languageModels.js';
import { FrameMessageRole, FrameTaskKind, FrameTaskStatus, IFrameChatMessage } from '../common/models.js';
import { FRAME_MODEL_PROFILES } from '../models/frameModelProfiles.js';
import { IFrameIntelligenceService } from '../services/frameIntelligence.js';

export const FRAME_LANGUAGE_MODEL_VENDOR = 'frame';

/**
 * Exposes Frame Efficient / Professional / Maximum in the Chat model picker.
 * Requests route through local Frame Intelligence (no cloud).
 */
export class FrameLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@IFrameIntelligenceService private readonly intelligence: IFrameIntelligenceService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.intelligence.models.onDidChangeModels(() => this._onDidChange.fire()));
		this._register(this.intelligence.runtimes.onDidChangeStatus(() => this._onDidChange.fire()));
	}

	async provideLanguageModelChatInfo(_options: ILanguageModelChatInfoOptions, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const activeId = this.intelligence.runtimes.getStatus().activeModelId
			?? this.intelligence.models.getActiveModel()?.id
			?? FRAME_MODEL_PROFILES[0]?.id;

		return FRAME_MODEL_PROFILES.map(profile => {
			const isActive = profile.id === activeId;
			const metadata: ILanguageModelChatMetadata = {
				extension: nullExtensionDescription.identifier,
				name: profile.displayName,
				id: profile.id,
				vendor: FRAME_LANGUAGE_MODEL_VENDOR,
				family: profile.architecture,
				version: '1.0.0',
				maxInputTokens: 32_000,
				maxOutputTokens: 8_000,
				isDefaultForLocation: {
					[ChatAgentLocation.Chat]: isActive || (!activeId && profile.id === FRAME_MODEL_PROFILES[0].id),
				},
				isUserSelectable: true,
				isBYOK: true,
				tooltip: profile.description,
				detail: `${profile.precision} · ${profile.memoryRequirementGb} GB RAM`,
				capabilities: {
					toolCalling: true,
					agentMode: true,
				},
			};
			return {
				metadata,
				identifier: `${FRAME_LANGUAGE_MODEL_VENDOR}/${profile.id}`,
			};
		});
	}

	async sendChatRequest(
		modelId: string,
		messages: IChatMessage[],
		_from: ExtensionIdentifier | undefined,
		_options: ILanguageModelChatRequestOptions,
		token: CancellationToken,
	): Promise<ILanguageModelChatResponse> {
		const prompt = extractUserPrompt(messages);
		const taskId = generateUuid();
		const profileId = modelId.includes('/') ? modelId.split('/').pop()! : modelId;
		this.logService.info(`[Frame LM] sendChatRequest model=${modelId} task=${taskId}`);

		const stream = new AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>();
		const result = (async () => {
			const store = new DisposableStore();
			store.add(token.onCancellationRequested(() => {
				void this.intelligence.orchestrator.cancelTask(taskId);
			}));
			try {
				const selected = this.intelligence.models.getModel(profileId);
				await this.intelligence.runtimes.updateConfig({
					activeModelId: profileId,
					...(selected?.localPath?.toLowerCase().endsWith('.gguf') ? { modelPath: selected.localPath } : {}),
				});
				const taskResult = await this.intelligence.submitTask({
					id: taskId,
					kind: FrameTaskKind.Chat,
					prompt,
					sessionId: `lm:${modelId}`,
					createdAt: Date.now(),
					messages: toFrameMessages(messages),
				});
				if (!token.isCancellationRequested && taskResult.status !== FrameTaskStatus.Cancelled) {
					const text = (taskResult.output ?? taskResult.message ?? taskResult.error ?? '').trim();
					if (text) {
						stream.emitOne({ type: 'text', value: text });
					}
				}
				stream.resolve();
				return taskResult;
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				stream.reject(error);
				throw error;
			} finally {
				store.dispose();
			}
		})();

		return { stream: stream.asyncIterable, result };
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		if (typeof message === 'string') {
			return Math.ceil(message.length / 4);
		}
		const text = message.content
			.map(part => ('value' in part ? String(part.value) : ''))
			.join('');
		return Math.ceil(text.length / 4);
	}
}

function toFrameMessages(messages: IChatMessage[]): IFrameChatMessage[] {
	return messages.map(message => {
		const content = message.content
			.map(part => (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'value' in part) ? String(part.value) : '')
			.filter(Boolean)
			.join('\n');
		const role = message.role === ChatMessageRole.Assistant
			? FrameMessageRole.Assistant
			: message.role === ChatMessageRole.System
				? FrameMessageRole.System
				: FrameMessageRole.User;
		return { id: generateUuid(), role, content, createdAt: Date.now() };
	}).filter(message => !!message.content);
}

function extractUserPrompt(messages: IChatMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role !== ChatMessageRole.User && message.role !== ChatMessageRole.System) {
			continue;
		}
		for (const part of message.content) {
			if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'value' in part) {
				parts.push(String(part.value));
			}
		}
	}
	return parts.filter(Boolean).join('\n\n').trim();
}
