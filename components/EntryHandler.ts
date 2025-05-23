import type { Stats } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { ComponentV2, FileAndURLPathConfig } from './ComponentV2';
import harperLogger from '../utility/logging/harper_logger.js';
import chokidar, { FSWatcher, FSWatcherEventMap } from 'chokidar';
import fg from 'fast-glob';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { FilesOption } from './deriveGlobOptions.js';

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
	#component: ComponentV2;
	#watcher?: FSWatcher;
	#logger: any;

	constructor(name: string, directory: string, config: FilesOption | FileAndURLPathConfig, logger?: any) {
		super();

		this.#component = new ComponentV2(name, directory, castConfig(config));
		this.#logger = logger || harperLogger.loggerWithTag(name);

		this.watch();
	}

	get name(): string {
		return this.#component.name;
	}

	get directory(): string {
		return this.#component.directory;
	}

	private handleAll(...[event, path, stats]: FSWatcherEventMap['all']): void {
		const absolutePath = join(this.directory, path);
		const urlPath = deriveURLPath(this.#component, path);

		switch (event) {
			case 'add':
			case 'change': {
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

	private handleError(error: unknown): void {
		this.emit('error', error);
	}

	private handleReady(): void {
		this.emit('ready');
	}

	private async watch() {
		await this.#watcher?.close();
		this.#watcher = undefined;

		return fg(this.#component.globOptions.source, {
			cwd: this.directory,
			onlyFiles: this.#component.globOptions.onlyFiles,
			onlyDirectories: this.#component.globOptions.onlyDirectories,
			ignore: this.#component.globOptions.ignore,
		})
			.then((matches) => {
				this.#logger.debug(`Watching entries: [${matches.join(', ')}]`);
				this.#watcher = chokidar
					.watch(matches, { cwd: this.directory, persistent: false })
					.on('all', this.handleAll.bind(this))
					.on('error', this.handleError.bind(this))
					.on('ready', this.handleReady.bind(this));

				return this.ready();
			})
			.catch((error) => {
				this.emit('error', error);
			});
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
		this.#component = new ComponentV2(this.name, this.directory, castConfig(config));

		return this.watch();
	}
}

function castConfig(config: FilesOption | FileAndURLPathConfig): FileAndURLPathConfig {
	return typeof config === 'string' || Array.isArray(config) || !('files' in config) ? { files: config } : config;
}

function deriveURLPath(component: ComponentV2, path: string): string {
	let entryPathPart = path;

	if (entryPathPart !== '/') {
		for (const patternRoot of component.patternRoots) {
			if (path.startsWith(patternRoot)) {
				entryPathPart = path.slice(patternRoot.length);
				break;
			}
		}
	}

	return join(component.baseURLPath, entryPathPart);
}
