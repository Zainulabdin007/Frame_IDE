/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';

export const FRAME_AI_VIEW_CONTAINER_ID = 'workbench.view.frameAI';
/** Control-plane sidebar (models / runtime / adapters). Conversation lives in built-in Chat. */
export const FRAME_AI_VIEW_ID = 'workbench.view.frameAI.control';

export const frameAIViewIcon = registerIcon(
	'frame-ai-view-icon',
	Codicon.sparkle,
	localize('frameAIViewIcon', 'View icon of the Frame AI view.'),
);
