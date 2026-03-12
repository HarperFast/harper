import { type Logger } from '../utility/logging/logger.ts';
import { loggerWithTag } from '../utility/logging/harper_logger.js';
import type { Stats } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { Component, FileAndURLPathConfig } from './Component.js';
import chokidar, { FSWatcher, FSWatcherEventMap } from 'chokidar';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { FilesOption } from './deriveGlobOptions.js';
import { deriveURLPath } from './deriveURLPath.js';
import { isMatch } from 'micromatch';

export interface BaseEntry {
	stats?: Stats;
	urlPath: string;
	absolutePath: string;
}

export interface FileEntry extends BaseEntry {
	contents: Buffer;
}

export interface EntryEvent extends BaseEntry {
	eventType: string;
	entryType: string;
}

export interface AddFileEvent extends EntryEvent, FileEntry {
	eventType: 'add';
	entryType: 'file';
}

export interface ChangeFileEvent extends EntryEvent, FileEntry {
	eventType: 'change';
	entryType: 'file';
}

export interface UnlinkFileEvent extends EntryEvent {
	eventType: 'unlink';
	entryType: 'file';
}

export type FileEntryEvent = AddFileEvent | ChangeFileEvent | UnlinkFileEvent;

export interface AddDirectoryEvent extends EntryEvent {
	eventType: 'addDir';
	entryType: 'directory';
}

export interface UnlinkDirectoryEvent extends EntryEvent {
	eventType: 'unlinkDir';
	entryType: 'directory';
}

export type DirectoryEntryEvent = AddDirectoryEvent | UnlinkDirectoryEvent;

export type onEntryEventHandler = (entry: FileEntryEvent | DirectoryEntryEvent) => void | Promise<void>;

export type EntryHandlerEventMap = {
	all: [entry: FileEntryEvent | DirectoryEntryEvent];
	close: [];
	error: [error: unknown];
	ready: [];
	initialLoadComplete: [];
	add: [entry: AddFileEvent];
	change: [entry: ChangeFileEvent];
	unlink: [entry: UnlinkFileEvent];
	addDir: [entry: AddDirectoryEvent];
	unlinkDir: [entry: UnlinkDirectoryEvent];
};

export class EntryHandler extends EventEmitter<EntryHandlerEventMap> {
	#component: Component;
	#watcher?: FSWatcher;
	#logger: Logger;
	#pendingFileReads: Set<Promise<void>>;
	#isInitialScanComplete: boolean;
	ready: Promise<any[]>;

	constructor(name: string, directory: string, config: FilesOption | FileAndURLPathConfig, logger?: Logger) {
		super();

		this.#component = new Component(name, directory, castConfig(config));
		this.#logger = logger || loggerWithTag(name);
		this.#pendingFileReads = new Set();
		this.#isInitialScanComplete = false;
		this.ready = once(this, 'ready');
		this.#watch();
	}

	get name(): string {
		return this.#component.name;
	}

	get directory(): string {
		return this.#component.directory;
	}

	#handleAll(...[event, path, stats]: FSWatcherEventMap['all']): void {
		if (path === '') path = '/';

		if (!isMatch(path, this.#component.globOptions.source, { ignore: this.#component.globOptions.ignore })) return;

		const absolutePath = join(this.directory, path);

		switch (event) {
			case 'add':
			case 'change': {
				const urlPath = deriveURLPath(this.#component, path, 'file');
				const fileReadPromise = readFile(absolutePath)
					.then((contents) => {
						const entry: AddFileEvent | ChangeFileEvent = {
							eventType: event,
							entryType: 'file' as const,
							contents,
							stats,
							absolutePath,
							urlPath,
						};
						this.emit('all', entry);
						this.emit(event, entry as any);
					})
					.finally(() => {
						this.#pendingFileReads.delete(fileReadPromise);
						this.#checkIfAllComplete();
					});

				this.#pendingFileReads.add(fileReadPromise);
				break;
			}
			case 'unlink': {
				const urlPath = deriveURLPath(this.#component, path, 'file');
				const entry: UnlinkFileEvent = {
					eventType: event,
					entryType: 'file',
					stats,
					absolutePath,
					urlPath,
				};
				this.emit('all', entry);
				this.emit(event, entry);
				break;
			}
			case 'addDir':
			case 'unlinkDir': {
				const urlPath = deriveURLPath(this.#component, path, 'directory');
				const entry: DirectoryEntryEvent = {
					eventType: event,
					entryType: 'directory' as const,
					stats,
					absolutePath,
					urlPath,
				};
				this.emit('all', entry);
				this.emit(event, entry as any);
				break;
			}
		}
	}

	#handleError(error: unknown): void {
		this.emit('error', error);
	}

	#handleReady(): void {
		this.#isInitialScanComplete = true;
		if (this.#pendingFileReads.size > 0) {
			this.#logger.debug?.(
				`Initial scan complete, still waiting for ${this.#pendingFileReads.size} pending file reads`
			);
		}
		this.#checkIfAllComplete();
	}

	#checkIfAllComplete(): void {
		// Only emit 'ready' once the initial scan is complete AND all file reads are done
		if (this.#isInitialScanComplete && this.#pendingFileReads.size === 0) {
			this.emit('ready');
		}
	}

	async #watch() {
		await this.#watcher?.close();
		this.#watcher = undefined;

		const allowedBases = this.#component.patternBases.map((base) => join(this.#component.directory, base));

		this.#watcher = chokidar
			.watch(this.#component.commonPatternBase, {
				cwd: this.#component.directory,
				persistent: false,
				ignored: (path) => {
					const normalizedPath = path.replace(/\\/g, '/');
					const normalizedBases = allowedBases.map((base) => base.replace(/\\/g, '/'));
					return (
						normalizedPath !== this.#component.directory.replace(/\\/g, '/') &&
						normalizedBases.every((base) => !normalizedPath.startsWith(base))
					);
				},
			})
			.on('all', this.#handleAll.bind(this))
			.on('error', this.#handleError.bind(this))
			.on('ready', this.#handleReady.bind(this));

		return this.ready;
	}

	close(): this {
		this.#watcher?.close();
		this.#watcher = undefined;

		this.emit('close');
		this.removeAllListeners();

		return this;
	}

	update(config: FilesOption | FileAndURLPathConfig) {
		this.#component = new Component(this.name, this.directory, castConfig(config));

		return this.#watch();
	}
}

function castConfig(config: FilesOption | FileAndURLPathConfig): FileAndURLPathConfig {
	return typeof config === 'string' || Array.isArray(config) || !('files' in config) ? { files: config } : config;
}
