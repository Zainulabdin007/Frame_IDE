/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import '../services/frameAIServices.contribution.js';
import './frameChatContribution.js';
import './frameProductCommands.contribution.js';

import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewDescriptor, IViewsRegistry, Extensions as ViewExtensions, ViewContainerLocation } from '../../../common/views.js';
import { FRAME_AI_VIEW_CONTAINER_ID, FRAME_AI_VIEW_ID, frameAIViewIcon } from './frameAI.js';
import { FrameAIViewPane, frameAIViewName } from './frameAIViewPane.js';

const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: FRAME_AI_VIEW_CONTAINER_ID,
	title: localize2('frameAI.containerTitle', "Frame"),
	icon: frameAIViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [FRAME_AI_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: FRAME_AI_VIEW_CONTAINER_ID,
	hideIfEmpty: true,
	order: 2,
}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });

const viewDescriptor: IViewDescriptor = {
	id: FRAME_AI_VIEW_ID,
	name: frameAIViewName,
	containerIcon: frameAIViewIcon,
	containerTitle: localize('frameAI.containerTitle', "Frame"),
	singleViewPaneContainerTitle: localize('frameAI.containerTitle', "Frame"),
	ctorDescriptor: new SyncDescriptor(FrameAIViewPane),
	canToggleVisibility: false,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: FRAME_AI_VIEW_CONTAINER_ID,
		title: localize2('frameAI.open', "Frame"),
		mnemonicTitle: localize({ key: 'miViewFrameAI', comment: ['&& denotes a mnemonic'] }, "&&Frame"),
		order: 2,
	},
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([viewDescriptor], viewContainer);
