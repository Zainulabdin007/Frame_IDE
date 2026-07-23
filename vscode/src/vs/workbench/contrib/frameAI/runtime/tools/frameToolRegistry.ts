/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { createBuiltinFrameTools } from './frameToolImplementations.js';
import {
	FrameToolName,
	FrameToolPermission,
	IFrameTool,
	IFrameToolContext,
	isFrameToolName,
} from './frameTools.js';

/**
 * Registers and looks up Frame IDE tools with permission gates.
 */
export class FrameToolRegistry {

	private readonly _tools = new Map<FrameToolName, IFrameTool>();
	private readonly _permissionOverrides = new Map<FrameToolPermission, boolean>();

	constructor(
		fileService: IFileService,
		workspaceService: IWorkspaceContextService,
		logService: ILogService,
	) {
		for (const tool of createBuiltinFrameTools(fileService, workspaceService, logService)) {
			this.register(tool);
		}
		// Hard defaults: no disk writes or shell until explicitly enabled.
		this._permissionOverrides.set('write', false);
		this._permissionOverrides.set('execute', false);
	}

	register(tool: IFrameTool): void {
		this._tools.set(tool.name, tool);
	}

	lookup(name: string): IFrameTool | undefined {
		if (!isFrameToolName(name)) {
			return undefined;
		}
		return this._tools.get(name);
	}

	list(): readonly IFrameTool[] {
		return [...this._tools.values()];
	}

	setPermissionEnabled(permission: FrameToolPermission, enabled: boolean): void {
		this._permissionOverrides.set(permission, enabled);
	}

	isAllowed(tool: IFrameTool): boolean {
		const override = this._permissionOverrides.get(tool.permission);
		if (override !== undefined) {
			return override;
		}
		return tool.enabled;
	}

	async execute(
		name: string,
		args: Readonly<Record<string, unknown>>,
		context: IFrameToolContext,
	): Promise<{ readonly success: boolean; readonly data?: unknown; readonly error?: string }> {
		const tool = this.lookup(name);
		if (!tool) {
			return { success: false, error: `Unknown tool: ${name}` };
		}
		if (!this.isAllowed(tool)) {
			return { success: false, error: `Tool '${tool.name}' is not permitted (${tool.permission}).` };
		}
		try {
			const result = await tool.execute(args, context);
			if (result.error) {
				return { success: false, error: result.error, data: result.data };
			}
			return { success: true, data: result.data };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}
}
