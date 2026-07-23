/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFrameContextBuildRequest, IFrameInferenceContext } from '../common/models.js';

export const IFrameContextService = createDecorator<IFrameContextService>('frameContextService');

/**
 * Frame Context Engine — assembles everything a future local model needs
 * before generation. Performs no inference and calls no cloud APIs.
 */
export interface IFrameContextService {
	readonly _serviceBrand: undefined;

	/**
	 * Gather editor, RAG, memory, and adapter context into an
	 * {@link IFrameInferenceContext} suitable for a future local runtime.
	 */
	build(request: IFrameContextBuildRequest): Promise<IFrameInferenceContext>;
}
