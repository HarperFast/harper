import chokidar, { FSWatcher } from 'chokidar';
import { readFileSync } from 'node:fs';
import { getConfigFilePath } from './configUtils.ts';
import { EventEmitter, once } from 'node:events';
import { parse } from 'yaml';
import {
	POLLING_FALLBACK_OPTIONS,
	PartialReadRetry,
	isPartialReadError,
	isWatcherExhaustionError,
	warnPartialReadGaveUp,
	warnWatcherFallback,
	warnWatcherListenerError,
} from '../utility/watcherFallback.ts';
import { resolveWatchTarget } from '../utility/watchPath.ts';

export class RootConfigWatcher extends EventEmitter {
	#configFilePath: string;
	#watchPath: string;
	#watcher!: FSWatcher;
	#config: any;
	#usingPolling: boolean;
	#closed: boolean;
	#openCount: number = 0;
	#partialRead: PartialReadRetry;
	ready: Promise<any[]>;

	constructor() {
		super();
		this.#configFilePath = getConfigFilePath();
		const watchTarget = resolveWatchTarget(this.#configFilePath);
		this.#watchPath = watchTarget.path;
		this.#partialRead = new PartialReadRetry(this.#configFilePath);
		this.#usingPolling = watchTarget.mustPoll;
		this.#closed = false;
		this.ready = once(this, 'ready');
		this.#openWatcher();
	}

	#openWatcher() {
		this.#openCount++;
		this.#watcher = chokidar
			.watch(this.#watchPath, {
				persistent: false,
				...(this.#usingPolling ? POLLING_FALLBACK_OPTIONS : {}),
			})
			.on('add', this.handleChange.bind(this))
			.on('change', this.handleChange.bind(this))
			.on('error', this.handleError.bind(this));
	}

	// Test-only: simulate the underlying chokidar watcher emitting an error.
	// Exposed so the polling-fallback path can be exercised without triggering a
	// real ENOSPC/EMFILE on the host.
	_simulateWatcherErrorForTests(error: unknown): void {
		this.handleError(error);
	}

	// Test-only: whether the watcher has fallen back to polling.
	get _usingPollingForTests(): boolean {
		return this.#usingPolling;
	}

	// Test-only: number of times the underlying watcher has been (re)opened.
	get _openCountForTests(): number {
		return this.#openCount;
	}

	handleError(error: unknown) {
		if (isWatcherExhaustionError(error)) {
			// Swallow every exhaustion error — chokidar can emit several before the
			// failed native watcher closes, and we don't want a flurry of ENOSPC to
			// surface to consumers in the middle of recovery.
			if (!this.#usingPolling) {
				warnWatcherFallback(this.#configFilePath);
				this.#usingPolling = true;
				// Start close() from a microtask, not directly here, so a synchronous throw
				// can't escape this 'error' listener as an uncaught exception.
				Promise.resolve()
					.then(() => this.#watcher.close())
					.catch(() => {
						// Teardown errors on an already-failed watcher are not actionable.
					})
					.then(() => {
						if (!this.#closed) this.#openWatcher();
					})
					.catch((error) => console.error(`Could not reopen the ${this.#configFilePath} watch on polling:`, error));
			}
			return;
		}
		this.emit('error', error);
	}

	// Reads synchronously so its descriptor cannot outlive this turn - see the invariant on
	// atomicWriteFile.
	handleChange() {
		let config;
		// Only the read and parse are guarded: a listener that throws must not be mistaken for a
		// half-written file and replayed.
		try {
			config = parse(readFileSync(this.#configFilePath, 'utf-8'));
		} catch (error) {
			// A missing file needs no re-read; anything else may be the file being replaced.
			if (isPartialReadError(error)) this.#scheduleReread(error);
			return;
		}
		// A snapshot that does not parse to an object is the other shape a half-written file
		// takes: `''`, `'\n'` and a truncated document all yield null, and adopting that would
		// hand every consumer a config with nothing in it.
		if (!config || typeof config !== 'object') {
			this.#scheduleReread();
			return;
		}
		this.#partialRead.settled();

		try {
			if (!this.#config) {
				this.#config = config;
				this.emit('ready', this.#config);
				return;
			}
			this.emit('change', (this.#config = config));
		} catch (error) {
			warnWatcherListenerError(this.#configFilePath, error);
		}
	}

	#scheduleReread(error?: unknown) {
		if (this.#partialRead.schedule(() => this.handleChange())) return;
		warnPartialReadGaveUp(this.#configFilePath, error);
	}

	close() {
		this.#closed = true;
		this.#partialRead.cancel();
		this.#watcher.close();
		this.#config = undefined;
		this.emit('close');
		this.removeAllListeners();
		return this;
	}

	get config() {
		return this.#config;
	}
}
