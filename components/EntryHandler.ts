import type { Stats } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { Component, FileAndURLPathConfig } from './Component.js';
import harperLogger from '../utility/logging/harper_logger.js';
import chokidar, { FSWatcher, FSWatcherEventMap } from 'chokidar';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { FilesOption } from './deriveGlobOptions.js';
import { deriveURLPath } from './deriveURLPath.js';
import { isMatch } from 'micromatch';

interface BaseEntry {
	stats?: Stats;
	urlPath: string;
	absolutePath: string;
}

interface FileEntry extends BaseEntry {
	contents: Buffer;
}

interface EntryEvent extends BaseEntry {
	eventType: string;
	entryType: string;
}

interface AddFileEvent extends EntryEvent, FileEntry {
	eventType: 'add';
	entryType: 'file';
}

interface ChangeFileEvent extends EntryEvent, FileEntry {
	eventType: 'change';
	entryType: 'file';
}

interface UnlinkFileEvent extends EntryEvent {
	eventType: 'unlink';
	entryType: 'file';
}

type FileEntryEvent = AddFileEvent | ChangeFileEvent | UnlinkFileEvent;

interface AddDirectoryEvent extends EntryEvent {
	eventType: 'addDir';
	entryType: 'directory';
}

interface UnlinkDirectoryEvent extends EntryEvent {
	eventType: 'unlinkDir';
	entryType: 'directory';
}

type DirectoryEntryEvent = AddDirectoryEvent | UnlinkDirectoryEvent;

export type onEntryEventHandler = (entry: FileEntryEvent | DirectoryEntryEvent) => void;

export type EntryHandlerEventMap = {
	all: [entry: FileEntryEvent | DirectoryEntryEvent];
	close: [];
	error: [error: unknown];
	ready: [];
	add: [entry: AddFileEvent];
	change: [entry: ChangeFileEvent];
	unlink: [entry: UnlinkFileEvent];
	addDir: [entry: AddDirectoryEvent];
	unlinkDir: [entry: UnlinkDirectoryEvent];
};

export class EntryHandler extends EventEmitter<EntryHandlerEventMap> {
	#component: Component;
	#watcher?: FSWatcher;
	#logger: any;

	constructor(name: string, directory: string, config: FilesOption | FileAndURLPathConfig, logger?: any) {
		super();

		this.#component = new Component(name, directory, castConfig(config));
		this.#logger = logger || harperLogger.loggerWithTag(name);

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
				readFile(absolutePath).then((contents) => {
					const entry: AddFileEvent | ChangeFileEvent = {
						eventType: event,
						entryType: 'file',
						contents,
						stats,
						absolutePath,
						urlPath,
					};
					this.emit('all', entry);
					this.emit(event, entry);
				});
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
					entryType: 'directory',
					stats,
					absolutePath,
					urlPath,
				};
				this.emit('all', entry);
				this.emit(event, entry);
				break;
			}
		}
	}

	#handleError(error: unknown): void {
		this.emit('error', error);
	}

	#handleReady(): void {
		this.emit('ready');
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
					return path !== this.#component.directory && allowedBases.every((base) => !path.startsWith(base));
				},
			})
			.on('all', this.#handleAll.bind(this))
			.on('error', this.#handleError.bind(this))
			.on('ready', this.#handleReady.bind(this));

		return this.ready();
	}

	close(): this {
		this.#watcher?.close();
		this.#watcher = undefined;

		this.emit('close');
		this.removeAllListeners();

		return this;
	}

	ready() {
		return once(this, 'ready');
	}

	update(config: FilesOption | FileAndURLPathConfig) {
		this.#component = new Component(this.name, this.directory, castConfig(config));

		return this.#watch();
	}
}

function castConfig(config: FilesOption | FileAndURLPathConfig): FileAndURLPathConfig {
	return typeof config === 'string' || Array.isArray(config) || !('files' in config) ? { files: config } : config;
}
