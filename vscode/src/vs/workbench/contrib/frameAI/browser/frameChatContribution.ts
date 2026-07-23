/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EnablementState } from '../../../services/extensionManagement/common/extensionManagement.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { IExtensionsWorkbenchService } from '../../extensions/common/extensions.js';
import { FrameChatAgent } from './frameChatAgent.js';
import { FRAME_LANGUAGE_MODEL_VENDOR, FrameLanguageModelProvider } from './frameLanguageModelProvider.js';

const CLOUD_CHAT_EXTENSION_IDS = [
	'github.copilot',
	'github.copilot-chat',
	'github.copilot-chat-nightly',
];

/**
 * Owns Frame as the default Chat agent + local language-model vendor,
 * and disables residual GitHub Copilot extensions that prompt for sign-in.
 */
export class FrameChatContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.frameChat';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(FrameChatAgent.registerDefaultAgents(instantiationService));
		this.logService.info('[Frame] Registered FrameChatAgent as default Chat / inline / terminal / notebook agents');

		const vendorDescriptor = {
			vendor: FRAME_LANGUAGE_MODEL_VENDOR,
			displayName: localize('frameLM.vendor', "Frame"),
			configuration: undefined,
			managementCommand: undefined,
			when: undefined,
		};
		languageModelsService.deltaLanguageModelChatProviderDescriptors([vendorDescriptor], []);
		this._register(toDisposable(() => languageModelsService.deltaLanguageModelChatProviderDescriptors([], [vendorDescriptor])));
		const provider = this._register(instantiationService.createInstance(FrameLanguageModelProvider));
		this._register(languageModelsService.registerLanguageModelProvider(FRAME_LANGUAGE_MODEL_VENDOR, provider));
		this.logService.info('[Frame] Registered language model vendor "frame" (Efficient / Professional / Maximum)');

		void this.disableCloudChatExtensions();
	}

	private async disableCloudChatExtensions(): Promise<void> {
		try {
			await this.extensionsWorkbenchService.queryLocal();
			const toDisable = this.extensionsWorkbenchService.local.filter(ext =>
				CLOUD_CHAT_EXTENSION_IDS.includes(ext.identifier.id.toLowerCase())
				&& (ext.enablementState === EnablementState.EnabledGlobally
					|| ext.enablementState === EnablementState.EnabledWorkspace
					|| ext.enablementState === EnablementState.EnabledByEnvironment)
			);
			if (!toDisable.length) {
				this.logService.info('[Frame] No cloud Copilot extensions enabled');
				return;
			}
			await this.extensionsWorkbenchService.setEnablement(toDisable, EnablementState.DisabledGlobally);
			this.logService.info(`[Frame] Disabled cloud chat extensions: ${toDisable.map(e => e.identifier.id).join(', ')}`);
		} catch (err) {
			this.logService.warn('[Frame] Failed to disable cloud chat extensions', err);
		}
	}
}

registerWorkbenchContribution2(FrameChatContribution.ID, FrameChatContribution, WorkbenchPhase.BlockRestore);
