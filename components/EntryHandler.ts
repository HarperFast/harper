import { type Logger } from '../utility/logging/logger.ts';
import { loggerWithTag } from '../utility/logging/harper_logger.ts';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Component, FileAndURLPathConfig } from './Component.ts';
import chokidar, { FSWatcher, FSWatcherEventMap } from 'chokidar';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { FilesOption } from './deriveGlobOptions.ts';
import { deriveURLPath } from './deriveURLPath.ts';
import { isMatch } from 'micromatch';
import {
	DIRECTORY_POLLING_FALLBACK_OPTIONS,
	isWatcherExhaustionError,
	warnWatcherFallback,
} from '../utility/watcherFallback.ts';

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

type EntrySnapshot =
	{ entryType: 'file'; urlPath: string; digest: Buffer } | { entryType: 'directory'; urlPath: string };

type RedeployScan = {
	generation: number;
	previousEntries: Map<string, EntrySnapshot>;
	currentEntries: Map<string, EntrySnapshot>;
	removalsEmitted: Set<string>;
	readFailures: Set<string>;
	readErrors: unknown[];
};

export class EntryHandler extends EventEmitter<EntryHandlerEventMap> {
	#component: Component;
	#watcher?: FSWatcher;
	#logger: Logger;
	#pendingFileReads: Set<Promise<void>>;
	#pendingFileReadsByGeneration: Map<number, Set<Promise<void>>>;
	#isInitialScanComplete: boolean;
	#readyGeneration = 0;
	#watchGeneration = 0;
	#eventSequence = 0;
	#latestPathSequence = new Map<string, number>();
	#entries = new Map<string, EntrySnapshot>();
	#redeployScan?: RedeployScan;
	// When true, #watch() short-circuits without creating a chokidar watcher.
	// pause() sets it, resume() clears it. Lets a deploy quiesce the watcher
	// without losing the EntryHandler instance (and therefore listener
	// attachments registered by plugins via scope.handleEntry(handler)).
	#paused = false;
	// Tracks the in-flight close() promise from pause() so resume() can await
	// the old watcher's inotify handles releasing before installing a fresh
	// chokidar instance — otherwise a rapid pause→resume can overlap teardown
	// and setup, which under inotify pressure can produce spurious EMFILE.
	#pausedClose?: Promise<void>;
	// Set while a watcher replacement is in flight, to serialize the next one. Concurrent
	// #watch() calls would otherwise each observe the same live watcher before their close()
	// await and then install their own, orphaning the intervening chokidar instance's inotify
	// handles. Left undefined when idle so the first install — which has nothing to await —
	// still claims its generation synchronously.
	#watchInstall?: Promise<void>;
	#usingPolling = false;
	#closed = false;
	#openCount = 0;
	// Chokidar instances opened but not yet closed. Normally holds at most one entry; a larger
	// set means a replacement watcher orphaned a live one, leaking its inotify handles.
	#liveWatchers = new Set<FSWatcher>();
	ready: Promise<any[]>;

	constructor(name: string, directory: string, config: FilesOption | FileAndURLPathConfig, logger?: Logger) {
		super();

		this.#component = new Component(name, directory, castConfig(config));
		this.#logger = logger || loggerWithTag(name);
		this.#pendingFileReads = new Set();
		this.#pendingFileReadsByGeneration = new Map();
		this.#isInitialScanComplete = false;
		this.ready = this.#createReadyLatch();
		// Fire-and-forget: the returned readiness latch rejects if the first generation emits
		// `error` before `ready`, and consumers observe that through the 'error' event instead.
		this.#watch().catch(() => {});
	}

	#createReadyLatch(): Promise<any[]> {
		const ready = new Promise<any[]>((resolve, reject) => {
			const cleanup = () => {
				this.off('ready', handleReady);
				this.off('error', handleError);
				this.off('close', handleClose);
			};
			const handleReady = () => {
				cleanup();
				resolve([]);
			};
			const handleError = (error: unknown) => {
				cleanup();
				reject(error);
			};
			const handleClose = () => {
				cleanup();
				reject(new Error(`Entry handler for ${this.name} closed before becoming ready`));
			};
			this.once('ready', handleReady);
			this.once('error', handleError);
			this.once('close', handleClose);
		});
		// Keep a fire-and-forget watcher lifecycle from producing an unhandled rejection while
		// preserving rejection for callers that await this same promise.
		void ready.catch(() => {});
		return ready;
	}

	get name(): string {
		return this.#component.name;
	}

	get directory(): string {
		return this.#component.directory;
	}

	#handleAll(generation: number, ...[event, path, stats]: FSWatcherEventMap['all']): void {
		if (generation !== this.#watchGeneration) return;
		if (path === '') path = '/';

		if (!isMatch(path, this.#component.globOptions.source, { ignore: this.#component.globOptions.ignore })) return;

		const absolutePath = join(this.directory, path);

		switch (event) {
			case 'add':
			case 'change': {
				this.#queueFileRead(generation, event, path, absolutePath, stats, readFile(absolutePath));
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
				this.#handleRemovedEntry(generation, entry);
				break;
			}
			case 'addDir':
			case 'unlinkDir': {
				const urlPath = deriveURLPath(this.#component, path, 'directory');
				if (event === 'addDir') {
					const entry: AddDirectoryEvent = {
						eventType: event,
						entryType: 'directory',
						stats,
						absolutePath,
						urlPath,
					};
					this.#handleAddedEntry(generation, entry, this.#snapshot(entry));
				} else {
					const entry: UnlinkDirectoryEvent = {
						eventType: event,
						entryType: 'directory',
						stats,
						absolutePath,
						urlPath,
					};
					this.#handleRemovedEntry(generation, entry);
				}
				break;
			}
		}
	}

	#queueFileRead(
		generation: number,
		event: 'add' | 'change',
		path: string,
		absolutePath: string,
		stats: Stats | undefined,
		contentsPromise: Promise<Buffer>
	): Promise<void> {
		const sequence = ++this.#eventSequence;
		this.#latestPathSequence.set(absolutePath, sequence);

		const fileReadPromise = contentsPromise
			.then(
				(contents) => {
					if (generation !== this.#watchGeneration || this.#latestPathSequence.get(absolutePath) !== sequence) return;
					const entry: AddFileEvent | ChangeFileEvent = {
						eventType: event,
						entryType: 'file',
						contents,
						stats,
						absolutePath,
						urlPath: deriveURLPath(this.#component, path, 'file'),
					};
					try {
						this.#handleAddedEntry(generation, entry, this.#snapshot(entry));
					} catch (error) {
						this.#reportConsumerError(error);
					}
				},
				(error) => {
					if (
						generation !== this.#watchGeneration ||
						(error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT'
					)
						return;
					if (this.#redeployScan?.generation === generation) {
						this.#redeployScan.readFailures.add(absolutePath);
						this.#redeployScan.readErrors.push(error);
					} else {
						this.#handleWatcherError(error);
					}
				}
			)
			.finally(() => {
				if (this.#latestPathSequence.get(absolutePath) === sequence) this.#latestPathSequence.delete(absolutePath);
				this.#pendingFileReads.delete(fileReadPromise);
				const generationReads = this.#pendingFileReadsByGeneration.get(generation);
				generationReads?.delete(fileReadPromise);
				if (generationReads?.size === 0) this.#pendingFileReadsByGeneration.delete(generation);
				this.#checkIfAllComplete(generation);
			});

		this.#pendingFileReads.add(fileReadPromise);
		let generationReads = this.#pendingFileReadsByGeneration.get(generation);
		if (!generationReads) this.#pendingFileReadsByGeneration.set(generation, (generationReads = new Set()));
		generationReads.add(fileReadPromise);
		return fileReadPromise;
	}

	#snapshot(entry: AddFileEvent | ChangeFileEvent | AddDirectoryEvent): EntrySnapshot {
		if (entry.entryType === 'file')
			return {
				entryType: entry.entryType,
				urlPath: entry.urlPath,
				digest: createHash('sha256').update(entry.contents).digest(),
			};
		return { entryType: entry.entryType, urlPath: entry.urlPath };
	}

	#handleAddedEntry(
		generation: number,
		entry: AddFileEvent | ChangeFileEvent | AddDirectoryEvent,
		snapshot: EntrySnapshot
	): void {
		if (generation !== this.#watchGeneration) return;
		const scan = this.#redeployScan?.generation === generation ? this.#redeployScan : undefined;
		if (!scan) {
			const wasKnown = this.#entries.has(entry.absolutePath);
			this.#entries.set(entry.absolutePath, snapshot);
			// A newer change read can supersede an initial add read for the same path. The consumer still
			// needs its first event to be an add so it can load the entry before handling later changes.
			if (entry.entryType === 'file' && entry.eventType === 'change' && !wasKnown)
				this.#emitEntry({ ...entry, eventType: 'add' });
			else this.#emitEntry(entry);
			return;
		}

		const wasRemovedDuringScan = scan.removalsEmitted.delete(entry.absolutePath);
		const currentEntry = scan.currentEntries.get(entry.absolutePath);
		const previousEntry = wasRemovedDuringScan
			? undefined
			: (currentEntry ?? scan.previousEntries.get(entry.absolutePath));
		scan.currentEntries.set(entry.absolutePath, snapshot);

		if (!previousEntry) {
			this.#emitAddition(entry);
			return;
		}
		if (previousEntry.entryType !== snapshot.entryType || previousEntry.urlPath !== snapshot.urlPath) {
			try {
				this.#emitRemoval(previousEntry, entry.absolutePath);
			} catch (error) {
				this.#reportConsumerError(error);
			}
			this.#emitAddition(entry);
			return;
		}
		if (
			snapshot.entryType === 'file' &&
			previousEntry.entryType === 'file' &&
			!previousEntry.digest.equals(snapshot.digest)
		) {
			this.#emitEntry({ ...entry, eventType: 'change' } as ChangeFileEvent);
		}
	}

	#emitAddition(entry: AddFileEvent | ChangeFileEvent | AddDirectoryEvent): void {
		if (entry.entryType === 'file') this.#emitEntry({ ...entry, eventType: 'add' });
		else this.#emitEntry({ ...entry, eventType: 'addDir' });
	}

	#handleRemovedEntry(generation: number, entry: UnlinkFileEvent | UnlinkDirectoryEvent): void {
		if (generation !== this.#watchGeneration) return;
		// Absence invalidates any pending read sequence for this path without retaining every path ever seen.
		this.#latestPathSequence.delete(entry.absolutePath);
		const scan = this.#redeployScan?.generation === generation ? this.#redeployScan : undefined;
		if (!scan) {
			this.#entries.delete(entry.absolutePath);
			this.#emitEntry(entry);
			return;
		}

		const knownEntry = scan.currentEntries.get(entry.absolutePath) ?? scan.previousEntries.get(entry.absolutePath);
		scan.currentEntries.delete(entry.absolutePath);
		if (!knownEntry || scan.removalsEmitted.has(entry.absolutePath)) return;
		this.#emitRemoval(knownEntry, entry.absolutePath);
		scan.removalsEmitted.add(entry.absolutePath);
	}

	#emitRemoval(snapshot: EntrySnapshot, absolutePath: string): void {
		if (snapshot.entryType === 'file')
			this.#emitEntry({ eventType: 'unlink', entryType: 'file', absolutePath, urlPath: snapshot.urlPath });
		else this.#emitEntry({ eventType: 'unlinkDir', entryType: 'directory', absolutePath, urlPath: snapshot.urlPath });
	}

	#emitEntry(entry: FileEntryEvent | DirectoryEntryEvent): void {
		this.emit('all', entry);
		switch (entry.eventType) {
			case 'add':
				this.emit('add', entry);
				break;
			case 'change':
				this.emit('change', entry);
				break;
			case 'unlink':
				this.emit('unlink', entry);
				break;
			case 'addDir':
				this.emit('addDir', entry);
				break;
			case 'unlinkDir':
				this.emit('unlinkDir', entry);
		}
	}

	#handleWatcherError(error: unknown): void {
		if (isWatcherExhaustionError(error)) {
			// Swallow every exhaustion error — chokidar can emit several before the
			// failed native watcher closes, and we don't want a flurry of ENOSPC to
			// surface to consumers in the middle of recovery.
			if (!this.#usingPolling) {
				warnWatcherFallback(this.#component.directory);
				this.#usingPolling = true;
				// Reopen with polling. #watch() itself guards against reopen-after-close.
				// The .catch is required because #watch() internally awaits the failed
				// watcher's close(), which can reject under the same FD/inotify pressure
				// that triggered this path; without it Node would treat that as an
				// unhandled rejection (matches the .catch pattern used in
				// OptionsWatcher / RootConfigWatcher).
				this.#watch().catch(() => {
					// Teardown errors on an already-failed watcher are not actionable.
				});
			}
			return;
		}
		this.#reportConsumerError(error);
	}

	#reportConsumerError(error: unknown): void {
		this.emit('error', error);
	}

	#handleReady(generation: number): void {
		if (generation !== this.#watchGeneration) return;
		this.#isInitialScanComplete = true;
		const pendingReads = this.#pendingFileReadsByGeneration.get(generation)?.size ?? 0;
		if (pendingReads > 0) {
			this.#logger.debug?.(`Initial scan complete, still waiting for ${pendingReads} pending file reads`);
		}
		this.#checkIfAllComplete(generation);
	}

	#checkIfAllComplete(generation: number): void {
		// Only emit 'ready' once the initial scan is complete AND all file reads are done
		if (
			generation === this.#watchGeneration &&
			this.#readyGeneration !== generation &&
			this.#isInitialScanComplete &&
			!this.#pendingFileReadsByGeneration.has(generation)
		) {
			this.#readyGeneration = generation;
			const { listenerErrors, readErrors } = this.#finishRedeployScan(generation);
			this.emit('ready');
			// The readiness latch rejects if `error` is emitted first. Surface consumer failures only
			// after resolving the generation's ready latch so one bad removal listener cannot strand startup.
			for (const error of listenerErrors) this.#reportConsumerError(error);
			for (const error of readErrors) this.#handleWatcherError(error);
		}
	}

	#finishRedeployScan(generation: number): { listenerErrors: unknown[]; readErrors: unknown[] } {
		const scan = this.#redeployScan;
		if (!scan || scan.generation !== generation) return { listenerErrors: [], readErrors: [] };
		const listenerErrors: unknown[] = [];
		for (const absolutePath of scan.readFailures) {
			const previousEntry = scan.previousEntries.get(absolutePath);
			if (previousEntry) scan.currentEntries.set(absolutePath, previousEntry);
		}
		const missingEntries = [...scan.previousEntries].filter(
			([absolutePath]) => !scan.currentEntries.has(absolutePath) && !scan.removalsEmitted.has(absolutePath)
		);
		// Match watcher deletion semantics: descendants disappear before the directory that contained them.
		missingEntries.sort(([a], [b]) => b.length - a.length);
		// Commit the generation before invoking consumer code. A synchronously throwing removal listener must
		// not leave the old snapshot installed or keep the readiness latch permanently unresolved.
		this.#entries = scan.currentEntries;
		this.#redeployScan = undefined;
		for (const [absolutePath, snapshot] of missingEntries) {
			try {
				this.#emitRemoval(snapshot, absolutePath);
			} catch (error) {
				listenerErrors.push(error);
			}
		}
		return { listenerErrors, readErrors: scan.readErrors };
	}

	#observedEntries(): Map<string, EntrySnapshot> {
		const scan = this.#redeployScan;
		if (!scan) return this.#entries;
		// A generation can be replaced before `ready`, after some events have already reached consumers.
		// Carry exactly that observed state forward: retain previously known paths that this partial scan
		// has not reached, apply additions/changes it emitted, and remove paths whose unlink was emitted.
		const observedEntries = new Map(scan.previousEntries);
		for (const absolutePath of scan.removalsEmitted) observedEntries.delete(absolutePath);
		for (const [absolutePath, snapshot] of scan.currentEntries) observedEntries.set(absolutePath, snapshot);
		return observedEntries;
	}

	async #watch() {
		// Replacement is serialized: an update() racing another update() or the polling-fallback
		// recovery must not tear down and install watchers concurrently, or the watcher installed
		// by the first call is overwritten by the second and never closed.
		const install = this.#watchInstall ? this.#watchInstall.then(() => this.#installWatcher()) : this.#installWatcher();
		// Release the chain once this replacement settles — a failed install must not block or
		// reject later callers.
		const settled: Promise<void> = install.then(
			() => {
				if (this.#watchInstall === settled) this.#watchInstall = undefined;
			},
			() => {
				if (this.#watchInstall === settled) this.#watchInstall = undefined;
			}
		);
		this.#watchInstall = settled;
		await install;

		return this.ready;
	}

	async #installWatcher(): Promise<void> {
		// If pause() retained an in-flight close, wait for it to release inotify
		// handles before we install a new watcher. Otherwise a fast pause→resume
		// can overlap teardown and setup under inotify pressure.
		if (this.#pausedClose) {
			await this.#pausedClose;
			this.#pausedClose = undefined;
		}

		const outgoing = this.#watcher;
		if (outgoing) {
			// Stays installed across the await so a close() landing in the gap still includes this
			// teardown in its own settle set; only clear it if close() didn't already replace it.
			try {
				await outgoing.close();
			} finally {
				this.#liveWatchers.delete(outgoing);
			}
			if (this.#watcher === outgoing) this.#watcher = undefined;
		}

		// If close() landed while a previous close()/recreate was awaiting, don't
		// install a fresh watcher — it would outlive the EntryHandler.
		if (this.#closed) return;

		// pause() may have landed in the gap before our async close resolved.
		// If so, do not install a replacement watcher — resume() will.
		if (this.#paused) return;
		const generation = ++this.#watchGeneration;

		// Every watcher generation gets its own readiness latch and compares its
		// initial scan with the last completed generation. The first generation
		// compares against an empty snapshot, preserving its cold-load add events;
		// pause/resume, config updates, and polling recovery all preserve logical
		// identity instead of replaying surviving entries as fresh adds.
		this.#isInitialScanComplete = false;
		const previousEntries = this.#observedEntries();
		this.#entries = previousEntries;
		this.#redeployScan = {
			generation,
			previousEntries,
			currentEntries: new Map(),
			removalsEmitted: new Set(),
			readFailures: new Set(),
			readErrors: [],
		};

		const allowedBases = this.#component.patternBases.map((base) => join(this.#component.directory, base));

		this.#openCount++;
		const watcher = (this.#watcher = chokidar
			.watch(this.#component.commonPatternBase, {
				cwd: this.#component.directory,
				persistent: false,
				followSymlinks: false,
				...(this.#usingPolling ? DIRECTORY_POLLING_FALLBACK_OPTIONS : {}),
				ignored: (path) => {
					const normalizedPath = path.replace(/\\/g, '/');
					const normalizedBases = allowedBases.map((base) => base.replace(/\\/g, '/'));
					const normalizedDirectory = this.#component.directory.replace(/\\/g, '/');

					// Determine the path relative to the component directory. Leading '/' is preserved
					// (or empty when the path *is* the component directory) so the regex anchors below
					// can use `(?:^|/)` to match the first segment without false positives on names
					// that merely contain the same substring (e.g. `mynode_modules`, `notgit`).
					const relativePath = normalizedPath.startsWith(normalizedDirectory)
						? normalizedPath.slice(normalizedDirectory.length)
						: normalizedPath;

					// Skip node_modules at any depth. This allows plugins loaded from node_modules
					// to still watch their own component files while ignoring their dependencies.
					if (/(?:^|\/)node_modules(?:\/|$)/.test(relativePath)) return true;

					// Skip transient package manager and VCS artifacts. Without these, an in-place
					// `npm install` during a component deploy writes log files and atomic-rename
					// temp directories that fire change events and drive an auto-reload restart
					// storm — see harper#488.
					if (/(?:^|\/)\.git(?:\/|$)/.test(relativePath)) return true;
					if (/(?:^|\/)\.tmp-/.test(relativePath)) return true;
					if (/(?:^|\/)(?:npm-debug|yarn-error|yarn-debug|pnpm-debug)\.log(?:\/|$)/.test(relativePath)) return true;

					return (
						normalizedPath !== normalizedDirectory && normalizedBases.every((base) => !normalizedPath.startsWith(base))
					);
				},
			})
			.on('all', (...args) => this.#handleAll(generation, ...args))
			.on('error', (error) => {
				if (generation === this.#watchGeneration) this.#handleWatcherError(error);
			})
			.on('ready', () => this.#handleReady(generation)));
		this.#liveWatchers.add(watcher);
	}

	// Test-only: simulate the underlying chokidar watcher emitting an error.
	// Exposed so the polling-fallback path can be exercised without triggering a
	// real ENOSPC/EMFILE on the host.
	_simulateWatcherErrorForTests(error: unknown): void {
		this.#handleWatcherError(error);
	}

	// Test-only: enqueue a controllable file read through the same generation checks as chokidar events.
	_simulateFileReadForTests(event: 'add' | 'change', path: string, contents: Promise<Buffer>): Promise<void> {
		const absolutePath = join(this.directory, path);
		return this.#queueFileRead(this.#watchGeneration, event, path, absolutePath, undefined, contents);
	}

	// Test-only: whether the watcher has fallen back to polling.
	get _usingPollingForTests(): boolean {
		return this.#usingPolling;
	}

	// Test-only: number of times the underlying watcher has been (re)opened.
	// Used to assert that a close()-during-fallback race didn't install a
	// replacement watcher.
	get _openCountForTests(): number {
		return this.#openCount;
	}

	// Test-only: chokidar instances opened but not yet closed. The invariant is <= 1; anything
	// higher means a replacement watcher orphaned a live one and leaked its inotify handles.
	get _liveWatcherCountForTests(): number {
		return this.#liveWatchers.size;
	}

	close(): Promise<this> {
		this.#watchGeneration++;
		this.#closed = true;
		const pendingReads = [...this.#pendingFileReads];
		const outgoing = this.#watcher;
		const watcherClose = outgoing
			? Promise.resolve(outgoing.close())
					.catch(() => {})
					.then(() => {
						this.#liveWatchers.delete(outgoing);
					})
			: Promise.resolve();
		this.#watcher = undefined;
		// If paused, there may be an in-flight close from pause() that hasn't settled yet.
		// Include it so close() doesn't resolve while inotify handles are still releasing.
		const pausedClose = this.#pausedClose ?? Promise.resolve();
		this.#pausedClose = undefined;

		this.emit('close');
		this.removeAllListeners();

		return Promise.allSettled([watcherClose, pausedClose, ...pendingReads]).then(() => this);
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
		if (this.#paused || this.#closed) return;
		// Invalidate callbacks and reads already queued by the watcher being paused. They belong to the
		// pre-deploy tree and must not be mistaken for events from the resumed generation.
		this.#watchGeneration++;
		this.#paused = true;
		// Reset `ready` to a fresh pending promise so the documented "awaiting
		// ready while paused will not resolve until resume()" contract holds even
		// when the watcher had already become ready before pause(). The next
		// 'ready' emit will come from the chokidar instance installed by resume().
		this.ready = this.#createReadyLatch();
		if (this.#watcher) {
			// Retain the close promise so resume()→#watch() can await full
			// teardown before opening a new watcher.
			const outgoing = this.#watcher;
			this.#pausedClose = Promise.resolve(outgoing.close())
				.catch(() => {
					// Teardown errors aren't actionable; swallow so resume can proceed.
				})
				.then(() => {
					this.#liveWatchers.delete(outgoing);
				});
			this.#watcher = undefined;
		}
	}

	/**
	 * Reinstate the watcher previously stopped by pause(). The fresh chokidar
	 * instance scans the post-pause tree, compares it with the retained snapshot,
	 * and emits only the logical add, change, unlink, addDir, and unlinkDir events.
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
		if (this.#closed) return this.ready;
		this.#watchGeneration++;
		this.#component = new Component(this.name, this.directory, castConfig(config));
		// Re-arm the readiness latch for parity with pause(). Without this, awaiting update() on an
		// already-ready handler resolves against the outgoing generation's 'ready' — before the
		// replacement generation has scanned, digested, and emitted its logical events.
		this.ready = this.#createReadyLatch();

		return this.#watch();
	}
}

function castConfig(config: FilesOption | FileAndURLPathConfig): FileAndURLPathConfig {
	return typeof config === 'string' || Array.isArray(config) || !('files' in config) ? { files: config } : config;
}
