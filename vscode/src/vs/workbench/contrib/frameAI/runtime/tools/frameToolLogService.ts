/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ensureFrameDotGitignore, redactSensitiveRecord, truncateForLocalPersistence } from '../../common/frameWorkspaceIgnore.js';
import { IFrameToolLogEntry, IFrameToolLogService } from './frameToolLog.js';

/**
 * Persists tool invocations under `.frame/logs/tools/`.
 * Arguments are redacted; `.frame/` is gitignored.
 */
export class FrameToolLogService extends Disposable implements IFrameToolLogService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async logToolInvocation(
		entry: Omit<IFrameToolLogEntry, 'id' | 'timestamp'> & { readonly id?: string; readonly timestamp?: number },
	): Promise<IFrameToolLogEntry> {
		const full: IFrameToolLogEntry = {
			...entry,
			arguments: redactSensitiveRecord(entry.arguments) as IFrameToolLogEntry['arguments'],
			resultPreview: entry.resultPreview
				? truncateForLocalPersistence(entry.resultPreview, 200)
				: entry.resultPreview,
			id: entry.id ?? generateUuid(),
			timestamp: entry.timestamp ?? Date.now(),
		};
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		if (!folder) {
			return full;
		}
		const dir = joinPath(folder, '.frame', 'logs', 'tools');
		await this.ensureDir(joinPath(folder, '.frame'));
		await ensureFrameDotGitignore(this.fileService, folder);
		await this.ensureDir(joinPath(folder, '.frame', 'logs'));
		await this.ensureDir(dir);
		const name = `tool-${full.timestamp}-${full.callId.slice(0, 8)}.json`;
		const uri = joinPath(dir, name);
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(full, null, 2) + '\n'));
		this.logService.info(`[FrameTools] Logged ${name} tool=${full.tool} success=${full.success}`);
		return full;
	}

	private async ensureDir(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// exists
		}
	}
}
