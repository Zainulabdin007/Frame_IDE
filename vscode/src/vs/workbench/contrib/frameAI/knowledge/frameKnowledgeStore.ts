/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Persist knowledge graph under `<workspace>/.frame/knowledge/`.
 * nodes.json · edges.json · metadata.json · version.json
 */

import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	FRAME_KNOWLEDGE_FORMAT,
	FRAME_KNOWLEDGE_FORMAT_VERSION,
	FRAME_KNOWLEDGE_SCHEMA_VERSION,
	IFrameKnowledgeEdge,
	IFrameKnowledgeGraphSnapshot,
	IFrameKnowledgeMetadata,
	IFrameKnowledgeNode,
	IFrameKnowledgeVersion,
	emptyKnowledgeMetadata,
} from './frameKnowledgeGraph.js';

export class FrameKnowledgeStore {

	constructor(
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) { }

	root(folder: URI): URI {
		return joinPath(folder, '.frame', 'knowledge');
	}

	async load(folder: URI): Promise<IFrameKnowledgeGraphSnapshot | undefined> {
		const root = this.root(folder);
		try {
			if (!(await this.fileService.exists(joinPath(root, 'version.json')))) {
				return undefined;
			}
			const [nodesBuf, edgesBuf, metaBuf, versionBuf] = await Promise.all([
				this.fileService.readFile(joinPath(root, 'nodes.json')),
				this.fileService.readFile(joinPath(root, 'edges.json')),
				this.fileService.readFile(joinPath(root, 'metadata.json')),
				this.fileService.readFile(joinPath(root, 'version.json')),
			]);
			const nodes = JSON.parse(nodesBuf.value.toString()) as IFrameKnowledgeNode[];
			const edges = JSON.parse(edgesBuf.value.toString()) as IFrameKnowledgeEdge[];
			const metadata = JSON.parse(metaBuf.value.toString()) as IFrameKnowledgeMetadata;
			const version = JSON.parse(versionBuf.value.toString()) as IFrameKnowledgeVersion;
			if (version.format !== FRAME_KNOWLEDGE_FORMAT || version.formatVersion !== FRAME_KNOWLEDGE_FORMAT_VERSION) {
				this.logService.warn('[FrameKnowledge] Unsupported store version — ignoring');
				return undefined;
			}
			return { nodes, edges, metadata, version };
		} catch (err) {
			this.logService.trace('[FrameKnowledge] load failed', err);
			return undefined;
		}
	}

	async save(folder: URI, snapshot: IFrameKnowledgeGraphSnapshot): Promise<void> {
		const root = this.root(folder);
		await this.ensureDir(joinPath(folder, '.frame'));
		await this.ensureDir(root);
		const version: IFrameKnowledgeVersion = {
			format: FRAME_KNOWLEDGE_FORMAT,
			formatVersion: FRAME_KNOWLEDGE_FORMAT_VERSION,
			schemaVersion: FRAME_KNOWLEDGE_SCHEMA_VERSION,
			builtAt: Date.now(),
		};
		const metadata: IFrameKnowledgeMetadata = {
			...snapshot.metadata,
			folder: folder.toString(),
			nodeCount: snapshot.nodes.length,
			edgeCount: snapshot.edges.length,
		};
		await Promise.all([
			this.fileService.writeFile(joinPath(root, 'nodes.json'), VSBuffer.fromString(JSON.stringify(snapshot.nodes, null, 2) + '\n')),
			this.fileService.writeFile(joinPath(root, 'edges.json'), VSBuffer.fromString(JSON.stringify(snapshot.edges, null, 2) + '\n')),
			this.fileService.writeFile(joinPath(root, 'metadata.json'), VSBuffer.fromString(JSON.stringify(metadata, null, 2) + '\n')),
			this.fileService.writeFile(joinPath(root, 'version.json'), VSBuffer.fromString(JSON.stringify(version, null, 2) + '\n')),
		]);
	}

	async clear(folder: URI): Promise<void> {
		const root = this.root(folder);
		if (!(await this.fileService.exists(root))) {
			return;
		}
		const empty = emptyKnowledgeMetadata(folder.toString());
		await this.save(folder, {
			nodes: [],
			edges: [],
			metadata: empty,
			version: {
				format: FRAME_KNOWLEDGE_FORMAT,
				formatVersion: FRAME_KNOWLEDGE_FORMAT_VERSION,
				schemaVersion: FRAME_KNOWLEDGE_SCHEMA_VERSION,
				builtAt: Date.now(),
			},
		});
	}

	private async ensureDir(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// exists
		}
	}
}
