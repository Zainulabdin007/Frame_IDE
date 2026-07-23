/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	FrameEdition,
	FrameModelCompatibilityStatus,
	IFrameHardwareProfile,
	IFrameModelCompatibilityResult,
	IFrameModelProfile,
} from '../common/models.js';
import { getFrameModelProfile, FRAME_MODEL_PROFILES } from '../models/frameModelProfiles.js';
import { IFrameHardwareService } from './frameHardware.js';
import { IFrameModelCompatibilityService } from './frameModelCompatibility.js';

/**
 * Compatibility rules for Frame Efficient / Professional / Maximum.
 *
 * Efficient (4-bit): lightest RAM floor
 * Professional (8-bit): mid tier
 * Maximum (FP16): highest RAM; warns without GPU / unified memory headroom
 */
export class FrameModelCompatibilityService extends Disposable implements IFrameModelCompatibilityService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IFrameHardwareService private readonly hardwareService: IFrameHardwareService,
	) {
		super();
	}

	evaluate(model: IFrameModelProfile, hardware: IFrameHardwareProfile): IFrameModelCompatibilityResult {
		const reasons: string[] = [];
		let status: FrameModelCompatibilityStatus = 'compatible';

		const need = model.memoryRequirementGb;
		const ram = hardware.ramGB;

		if (ram < need) {
			status = 'unsupported';
			reasons.push(`Requires ~${need} GB RAM; detected ${ram} GB.`);
		} else if (ram < need + headroomGb(model.edition)) {
			status = 'warning';
			reasons.push(`Tight fit: ~${need} GB recommended; detected ${ram} GB (little headroom for IDE + OS).`);
		}

		if (model.edition === FrameEdition.Maximum) {
			if (!hardware.gpuAvailable && !hardware.appleSilicon) {
				if (status === 'compatible') {
					status = 'warning';
				}
				reasons.push('FP16 benefits from GPU or Apple Silicon unified memory.');
			} else if (hardware.gpuMemoryGB !== undefined && hardware.gpuMemoryGB < need && !hardware.appleSilicon) {
				if (status === 'compatible') {
					status = 'warning';
				}
				reasons.push(`GPU memory ~${hardware.gpuMemoryGB} GB may be low for FP16 (want ~${need} GB).`);
			}
		}

		if (model.edition === FrameEdition.Professional && ram < 12 && status === 'compatible') {
			status = 'warning';
			reasons.push('8-bit profile runs best with 12+ GB system memory.');
		}

		if (status === 'compatible' && reasons.length === 0) {
			reasons.push('Meets RAM and platform heuristics for this edition.');
		}

		const message = status === 'compatible'
			? 'Compatible'
			: status === 'warning'
				? (reasons[0] ?? 'Requires more memory or GPU headroom')
				: (reasons[0] ?? 'Unsupported on this hardware');

		return {
			modelId: model.id,
			status,
			compatible: status === 'compatible' || status === 'warning',
			reasons,
			message,
		};
	}

	async evaluateById(modelId: string, hardware?: IFrameHardwareProfile): Promise<IFrameModelCompatibilityResult> {
		const profile = getFrameModelProfile(modelId);
		if (!profile) {
			return {
				modelId,
				status: 'unsupported',
				compatible: false,
				reasons: ['Unknown model profile.'],
				message: 'Unknown model profile',
			};
		}
		const hw = hardware ?? await this.hardwareService.detect();
		return this.evaluate(profile, hw);
	}

	async evaluateAll(hardware?: IFrameHardwareProfile): Promise<readonly IFrameModelCompatibilityResult[]> {
		const hw = hardware ?? await this.hardwareService.detect();
		return FRAME_MODEL_PROFILES.map(p => this.evaluate(p, hw));
	}
}

function headroomGb(edition: FrameEdition): number {
	switch (edition) {
		case FrameEdition.Efficient:
			return 2;
		case FrameEdition.Professional:
			return 4;
		case FrameEdition.Maximum:
			return 8;
		default:
			return 2;
	}
}
