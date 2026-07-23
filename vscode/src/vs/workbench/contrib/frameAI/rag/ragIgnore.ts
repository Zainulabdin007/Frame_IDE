/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ignore rules and language heuristics for Frame RAG workspace scanning.
 * Fully local — no network.
 */

import { URI } from '../../../../base/common/uri.js';

/** Directory names skipped while walking the workspace. */
export const FRAME_RAG_IGNORED_DIRS = new Set([
	'node_modules',
	'.git',
	'.svn',
	'.hg',
	'.frame', // never re-index our own RAG store
	'dist',
	'out',
	'build',
	'.build',
	'target',
	'bin',
	'obj',
	'__pycache__',
	'.next',
	'.nuxt',
	'.turbo',
	'.cache',
	'coverage',
	'vendor',
	'.venv',
	'venv',
	'Pods',
	'DerivedData',
]);

/** File extensions treated as binary / non-source. */
export const FRAME_RAG_BINARY_EXTENSIONS = new Set([
	'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'icns', 'bmp', 'svg',
	'woff', 'woff2', 'ttf', 'eot', 'otf',
	'mp3', 'mp4', 'wav', 'mov', 'avi', 'webm',
	'zip', 'gz', 'tgz', 'bz2', '7z', 'rar', 'tar',
	'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
	'exe', 'dll', 'so', 'dylib', 'o', 'a', 'class', 'jar', 'wasm',
	'bin', 'dat', 'db', 'sqlite', 'sqlite3',
	'lock', // package-lock / yarn.lock etc. — huge & low signal
]);

/** Exact basenames skipped even when extension is text-like (e.g. *.json / *.yaml). */
export const FRAME_RAG_IGNORED_BASENAMES = new Set([
	'package-lock.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'npm-shrinkwrap.json',
	'composer.lock',
	'Cargo.lock',
	'poetry.lock',
	'Gemfile.lock',
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
	ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
	mjs: 'javascript', cjs: 'javascript', cts: 'typescript', mts: 'typescript',
	py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
	c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
	cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift',
	md: 'markdown', json: 'json', jsonc: 'jsonc', yml: 'yaml', yaml: 'yaml',
	toml: 'toml', xml: 'xml', html: 'html', css: 'css', scss: 'scss', less: 'less',
	sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
	sql: 'sql', graphql: 'graphql', vue: 'vue', svelte: 'svelte',
};

/** Max file size to read into the index (512 KiB). */
export const FRAME_RAG_MAX_FILE_BYTES = 512 * 1024;

/** Soft cap on files indexed per reindex. */
export const FRAME_RAG_MAX_FILES = 2500;

export function getExtension(path: string): string {
	const base = path.split(/[/\\]/).pop() ?? '';
	const dot = base.lastIndexOf('.');
	if (dot <= 0) {
		return '';
	}
	return base.slice(dot + 1).toLowerCase();
}

export function detectLanguage(path: string): string {
	const ext = getExtension(path);
	return LANGUAGE_BY_EXT[ext] ?? (ext || 'plaintext');
}

export function shouldIgnoreDirName(name: string): boolean {
	return FRAME_RAG_IGNORED_DIRS.has(name);
}

export function shouldIgnoreFilePath(relativePath: string): boolean {
	const parts = relativePath.split(/[/\\]/).filter(Boolean);
	for (const part of parts.slice(0, -1)) {
		if (FRAME_RAG_IGNORED_DIRS.has(part)) {
			return true;
		}
	}
	const base = parts[parts.length - 1] ?? '';
	if (FRAME_RAG_IGNORED_BASENAMES.has(base.toLowerCase()) || FRAME_RAG_IGNORED_BASENAMES.has(base)) {
		return true;
	}
	if (base.startsWith('.') && base !== '.env.example') {
		// skip dotfiles except documented examples
		if (!base.endsWith('.example') && !base.endsWith('.sample')) {
			return true;
		}
	}
	const ext = getExtension(base);
	if (FRAME_RAG_BINARY_EXTENSIONS.has(ext)) {
		return true;
	}
	if (base.endsWith('.min.js') || base.endsWith('.min.css') || base.endsWith('.map')) {
		return true;
	}
	return false;
}

export function isTextLikePath(path: string): boolean {
	const ext = getExtension(path);
	if (!ext) {
		// allow common extensionless source names
		const base = path.split(/[/\\]/).pop()?.toLowerCase() ?? '';
		return ['makefile', 'dockerfile', 'jenkinsfile', 'rakefile', 'gemfile'].includes(base);
	}
	return !FRAME_RAG_BINARY_EXTENSIONS.has(ext);
}

export function relativePathFromFolder(folder: URI, file: URI): string {
	const folderPath = folder.path.replace(/\/+$/, '');
	const filePath = file.path;
	if (filePath === folderPath) {
		return '';
	}
	if (filePath.startsWith(folderPath + '/')) {
		return filePath.slice(folderPath.length + 1);
	}
	return filePath;
}
