import { type Logger } from '../utility/logging/logger.ts';
import { loggerWithTag } from '../utility/logging/harper_logger.ts';
import type { Stats } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { Component, FileAndURLPathConfig } from './Component.ts';
import chokidar, { FSWatcher, FSWatcherEventMap } from 'chokidar';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { FilesOption } from './deriveGlobOptions.ts';
import { deriveURLPath } from './deriveURLPath.ts';
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
	// When true, #watch() short-circuits without creating a chokidar watcher.
	// pause() sets it, resume() clears it. Lets a deploy quiesce the watcher
	// without losing the EntryHandler instance (and therefore listener
	// attachments registered by plugins via scope.handleEntry(handler)).
	#paused: boolean = false;
	// Tracks the in-flight close() promise from pause() so resume() can await
	// the old watcher's inotify handles releasing before installing a fresh
	// chokidar instance — otherwise a rapid pause→resume can overlap teardown
	// and setup, which under inotify pressure can produce spurious EMFILE.
	#pausedClose?: Promise<void>;
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
		// If pause() retained an in-flight close, wait for it to release inotify
		// handles before we install a new watcher. Otherwise a fast pause→resume
		// can overlap teardown and setup under inotify pressure.
		if (this.#pausedClose) {
			await this.#pausedClose;
			this.#pausedClose = undefined;
		}

		await this.#watcher?.close();
		this.#watcher = undefined;

		// pause() may have landed in the gap before our async close resolved.
		// If so, do not install a replacement watcher — resume() will.
		if (this.#paused) return this.ready;

		// When a fresh watcher is installed (after pause+resume, or update), the
		// initial scan emits add events anew, so reset the readiness latch so
		// `ready` resolves after the new scan completes.
		this.#isInitialScanComplete = false;

		const allowedBases = this.#component.patternBases.map((base) => join(this.#component.directory, base));

		this.#watcher = chokidar
			.watch(this.#component.commonPatternBase, {
				cwd: this.#component.directory,
				persistent: false,
				followSymlinks: false,
				ignored: (path) => {
					const normalizedPath = path.replace(/\\/g, '/');
					const normalizedBases = allowedBases.map((base) => base.replace(/\\/g, '/'));
					const normalizedDirectory = this.#component.directory.replace(/\\/g, '/');

					// Check for nested node_modules relative to the component directory
					// This allows plugins loaded from node_modules to watch their own files
					// while still ignoring their nested node_modules dependencies
					const relativePath = normalizedPath.startsWith(normalizedDirectory + '/')
						? normalizedPath.slice(normalizedDirectory.length)
						: normalizedPath.startsWith(normalizedDirectory)
							? normalizedPath.slice(normalizedDirectory.length)
							: normalizedPath;
					const hasNestedNodeModules = relativePath.includes('/node_modules');

					return (
						hasNestedNodeModules ||
						(normalizedPath !== normalizedDirectory &&
							normalizedBases.every((base) => !normalizedPath.startsWith(base)))
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

	/**
	 * Quiesce the watcher without tearing down the EntryHandler. Closes the
	 * underlying chokidar watcher (releasing inotify handles for the watched
	 * tree) but preserves all listeners attached to this instance, so plugins
	 * that registered `scope.handleEntry(handler)` keep their handler wired up
	 * across the pause.
	 *
	 * Idempotent. Awaiting `ready` while paused will not resolve until resume().
	 */
	pause(): void {
		this.#paused = true;
		// Reset `ready` to a fresh pending promise so the documented "awaiting
		// ready while paused will not resolve until resume()" contract holds even
		// when the watcher had already become ready before pause(). The next
		// 'ready' emit will come from the chokidar instance installed by resume().
		this.ready = once(this, 'ready');
		if (this.#watcher) {
			// Retain the close promise so resume()→#watch() can await full
			// teardown before opening a new watcher.
			this.#pausedClose = Promise.resolve(this.#watcher.close()).catch(() => {
				// Teardown errors aren't actionable; swallow so resume can proceed.
			});
			this.#watcher = undefined;
		}
	}

	/**
	 * Reinstate the watcher previously stopped by pause(). The fresh chokidar
	 * instance does an initial scan and emits add events for every file
	 * currently matching the configured globs — by design, since the typical
	 * caller (Scope, on deploy:end) wants plugins to see the post-deploy tree
	 * as if loading cold.
	 *
	 * No-op if not currently paused.
	 */
	resume(): Promise<any[]> {
		if (!this.#paused) return this.ready;
		this.#paused = false;
		// `this.ready` was already reset to a pending promise in pause(); just
		// trigger the watcher recreation and let its 'ready' emit resolve it.
		return this.#watch();
	}

	update(config: FilesOption | FileAndURLPathConfig) {
		this.#component = new Component(this.name, this.directory, castConfig(config));

		return this.#watch();
	}
}

function castConfig(config: FilesOption | FileAndURLPathConfig): FileAndURLPathConfig {
	return typeof config === 'string' || Array.isArray(config) || !('files' in config) ? { files: config } : config;
}
