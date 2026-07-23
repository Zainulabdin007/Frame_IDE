/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	IFrameHardwareProfile,
	IFrameModelCompatibilityResult,
	IFrameModelProfile,
} from '../common/models.js';

export const IFrameModelCompatibilityService = createDecorator<IFrameModelCompatibilityService>('frameModelCompatibilityService');

/**
 * Evaluates Frame edition profiles against detected hardware.
 * Does not download or load models.
 */
export interface IFrameModelCompatibilityService {
	readonly _serviceBrand: undefined;

	evaluate(model: IFrameModelProfile, hardware: IFrameHardwareProfile): IFrameModelCompatibilityResult;

	evaluateById(modelId: string, hardware?: IFrameHardwareProfile): Promise<IFrameModelCompatibilityResult>;

	evaluateAll(hardware?: IFrameHardwareProfile): Promise<readonly IFrameModelCompatibilityResult[]>;
}
