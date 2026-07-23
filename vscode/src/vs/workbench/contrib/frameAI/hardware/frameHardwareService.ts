/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isLinux, isMacintosh, isNative, isWindows } from '../../../../base/common/platform.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IFrameHardwareProfile } from '../common/models.js';
import { IFrameHardwareService } from './frameHardware.js';

/**
 * Best-effort local hardware detection.
 * Uses native host stats when available; falls back to platform / browser hints.
 */
export class FrameHardwareService extends Disposable implements IFrameHardwareService {

	declare readonly _serviceBrand: undefined;

	private _cached: IFrameHardwareProfile | undefined;
	private _detectPromise: Promise<IFrameHardwareProfile> | undefined;

	private readonly _onDidChangeHardware = this._register(new Emitter<IFrameHardwareProfile>());
	readonly onDidChangeHardware: Event<IFrameHardwareProfile> = this._onDidChangeHardware.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		void this.detect();
	}

	getCachedProfile(): IFrameHardwareProfile | undefined {
		return this._cached;
	}

	async detect(force = false): Promise<IFrameHardwareProfile> {
		if (!force && this._cached) {
			return this._cached;
		}
		if (!force && this._detectPromise) {
			return this._detectPromise;
		}
		this._detectPromise = this.doDetect();
		try {
			this._cached = await this._detectPromise;
			this._onDidChangeHardware.fire(this._cached);
			this.logService.info(
				`[FrameHardware] ${this._cached.osLabel} ${this._cached.architecture} ram=${this._cached.ramGB}GB gpu=${this._cached.gpuAvailable ? (this._cached.gpuMemoryGB ?? '?') + 'GB' : 'none'}`,
			);
			return this._cached;
		} finally {
			this._detectPromise = undefined;
		}
	}

	private async doDetect(): Promise<IFrameHardwareProfile> {
		const os = isMacintosh ? 'darwin' : isWindows ? 'win32' : isLinux ? 'linux' : 'unknown';
		const osLabel = isMacintosh ? (await this.isAppleSiliconHint() ? 'Apple Silicon' : 'macOS')
			: isWindows ? 'Windows'
				: isLinux ? 'Linux'
					: 'Unknown OS';

		let architecture = this.readProcessArch();
		let ramGB = 0;
		let freeRamGB: number | undefined;
		let cpuModel: string | undefined;
		let appleSilicon = isMacintosh && (architecture === 'arm64' || architecture === 'aarch64');

		const native = this.tryGetNativeHost();
		if (native) {
			try {
				const [props, stats] = await Promise.all([
					native.getOSProperties(),
					native.getOSStatistics(),
				]);
				if (props.arch) {
					architecture = props.arch;
				}
				appleSilicon = isMacintosh && (architecture === 'arm64' || architecture === 'aarch64');
				ramGB = bytesToGb(stats.totalmem);
				freeRamGB = bytesToGb(stats.freemem);
				cpuModel = props.cpus?.[0]?.model;
				if (appleSilicon && osLabel === 'macOS') {
					// prefer Apple Silicon label
				}
			} catch (err) {
				this.logService.trace('[FrameHardware] native stats unavailable', err);
			}
		}

		if (ramGB <= 0) {
			ramGB = readBrowserDeviceMemoryGb() || (isNative ? 8 : 4);
		}

		const gpu = await this.detectGpu(appleSilicon, ramGB);

		return {
			os,
			osLabel: appleSilicon ? 'Apple Silicon' : osLabel,
			architecture,
			ramGB,
			freeRamGB,
			gpuAvailable: gpu.available,
			gpuMemoryGB: gpu.memoryGB,
			gpuName: gpu.name,
			appleSilicon,
			cpuModel,
			detectedAt: Date.now(),
		};
	}

	private async isAppleSiliconHint(): Promise<boolean> {
		const arch = this.readProcessArch();
		return arch === 'arm64' || arch === 'aarch64';
	}

	private readProcessArch(): string {
		try {
			const g = globalThis as { vscode?: { process?: { arch?: string } }; process?: { arch?: string } };
			return g.vscode?.process?.arch || g.process?.arch || 'unknown';
		} catch {
			return 'unknown';
		}
	}

	private tryGetNativeHost(): INativeHostService | undefined {
		if (!isNative) {
			return undefined;
		}
		try {
			return this.instantiationService.invokeFunction(accessor => {
				try {
					return accessor.get(INativeHostService);
				} catch {
					return undefined;
				}
			});
		} catch {
			return undefined;
		}
	}

	private async detectGpu(appleSilicon: boolean, ramGB: number): Promise<{ available: boolean; memoryGB?: number; name?: string }> {
		// Apple Silicon: unified memory — treat system RAM as available GPU budget.
		if (appleSilicon) {
			return {
				available: true,
				memoryGB: ramGB,
				name: 'Apple Silicon (unified memory)',
			};
		}

		// Best-effort WebGPU adapter name (no model load).
		try {
			const nav = globalThis.navigator as { gpu?: { requestAdapter?: () => Promise<{ requestAdapterInfo?: () => Promise<{ device?: string; description?: string }> } | null> } } | undefined;
			const adapter = await nav?.gpu?.requestAdapter?.();
			if (adapter?.requestAdapterInfo) {
				const info = await adapter.requestAdapterInfo();
				const name = info.device || info.description || 'GPU';
				return { available: true, name };
			}
			if (adapter) {
				return { available: true, name: 'GPU (WebGPU)' };
			}
		} catch {
			// ignore
		}

		return { available: false };
	}
}

function bytesToGb(bytes: number): number {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return 0;
	}
	return Math.max(1, Math.round(bytes / (1024 ** 3)));
}

function readBrowserDeviceMemoryGb(): number {
	try {
		const mem = (navigator as { deviceMemory?: number }).deviceMemory;
		return typeof mem === 'number' && mem > 0 ? mem : 0;
	} catch {
		return 0;
	}
}
