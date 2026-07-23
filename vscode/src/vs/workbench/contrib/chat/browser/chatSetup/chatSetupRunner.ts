/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatSetup.css';
import { Lazy } from '../../../../../base/common/lazy.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import product from '../../../../../platform/product/common/product.js';
import { ChatEntitlementContext } from '../../../../services/chat/common/chatEntitlementService.js';
import { ChatSetupController } from './chatSetupController.js';
import { IChatSetupResult, IChatSetupRunOptions } from './chatSetup.js';

const defaultChat = {
	chatRefreshTokenCommand: product.defaultChatAgent?.chatRefreshTokenCommand ?? '',
};

export class ChatSetup {

	private static instance: ChatSetup | undefined = undefined;
	static getInstance(instantiationService: IInstantiationService, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): ChatSetup {
		let instance = ChatSetup.instance;
		if (!instance) {
			instance = ChatSetup.instance = instantiationService.createInstance(ChatSetup, context, controller);
		}

		return instance;
	}

	private pendingRun: Promise<IChatSetupResult> | undefined = undefined;

	constructor(
		private readonly context: ChatEntitlementContext,
		_controller: Lazy<ChatSetupController>,
		@ILogService private readonly logService: ILogService,
	) { }

	skipDialog(): void {
		// Frame: setup dialogs are never shown; keep API for callers.
	}

	async run(options?: IChatSetupRunOptions): Promise<IChatSetupResult> {
		if (this.pendingRun) {
			return this.pendingRun;
		}

		this.pendingRun = this.doRun(options);

		try {
			return await this.pendingRun;
		} finally {
			this.pendingRun = undefined;
		}
	}

	private async doRun(_options?: IChatSetupRunOptions): Promise<IChatSetupResult> {
		// Frame: fully local — never open Microsoft/GitHub/Apple/Google sign-in.
		// Mark Copilot chat setup complete so residual Chat UI stops gating on accounts.
		// Frame AI panel already routes to the orchestrator without this path.
		this.logService.info('[Frame] Skipping chat Microsoft account setup (local Frame AI)');
		await this.context.update({ later: false });
		await this.context.update({ completed: true });
		await this.context.update({ hidden: false });
		return { dialogSkipped: true, success: true };
	}
}

//#endregion

export function refreshTokens(commandService: ICommandService): void {
	// ugly, but we need to signal to the extension that entitlements changed
	commandService.executeCommand(defaultChat.chatRefreshTokenCommand);
}
