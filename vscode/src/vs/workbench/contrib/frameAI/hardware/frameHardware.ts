/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFrameHardwareProfile } from '../common/models.js';

export const IFrameHardwareService = createDecorator<IFrameHardwareService>('frameHardwareService');

/**
 * Local hardware probe for model compatibility.
 * Never downloads models or opens cloud sockets.
 */
export interface IFrameHardwareService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeHardware: Event<IFrameHardwareProfile>;

	/** Detect (or return cached) local hardware profile. */
	detect(force?: boolean): Promise<IFrameHardwareProfile>;

	getCachedProfile(): IFrameHardwareProfile | undefined;
}
