/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { FRAME_AI_VIEW_CONTAINER_ID } from './frameAI.js';

/**
 * product.json still points SCM / setup hooks at frame.ai.* command IDs.
 * Register local no-op / Frame-sidebar handlers so those calls never 404.
 */
function registerFrameProductCommand(id: string, title: string, run?: (accessor: ServicesAccessor) => void | Promise<void>): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id,
				// NLS requires literal keys — use a plain ILocalizedString for dynamic titles.
				title: { value: title, original: title },
				category: Categories.Developer,
				f1: false,
			});
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			if (run) {
				await run(accessor);
				return;
			}
			accessor.get(ILogService).info(`[Frame] Command ${id} is a local no-op (cloud Copilot hooks removed)`);
		}
	});
}

registerFrameProductCommand('frame.ai.refreshToken', 'Frame: Refresh Token (noop)');
registerFrameProductCommand('frame.ai.debug.extensionState', 'Frame: Debug Extension State (noop)');
registerFrameProductCommand('frame.ai.toggleStatusMenu', 'Frame: Toggle Status Menu', async accessor => {
	await accessor.get(ICommandService).executeCommand(FRAME_AI_VIEW_CONTAINER_ID);
});
registerFrameProductCommand('frame.ai.open.walkthrough', 'Frame: Open Walkthrough', async accessor => {
	await accessor.get(ICommandService).executeCommand(FRAME_AI_VIEW_CONTAINER_ID);
});
registerFrameProductCommand('frame.ai.git.generateCommitMessage', 'Frame: Generate Commit Message', async accessor => {
	await accessor.get(ICommandService).executeCommand('workbench.view.scm');
	accessor.get(INotificationService).info('Type a commit message in Source Control, then Commit. Frame AI commit-message generation is coming soon.');
});
registerFrameProductCommand('frame.ai.git.resolveMergeConflicts', 'Frame: Resolve Merge Conflicts', async accessor => {
	accessor.get(INotificationService).info('Frame: local merge-conflict resolution is not wired yet. Open Chat and describe the conflict.');
	await accessor.get(ICommandService).executeCommand('workbench.action.chat.open');
});
