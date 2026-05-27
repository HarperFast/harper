import chokidar, { FSWatcher } from 'chokidar';
import { readFile } from 'node:fs/promises';
import { getConfigFilePath } from './configUtils.js';
import { EventEmitter, once } from 'node:events';
import { parse } from 'yaml';
import { POLLING_FALLBACK_OPTIONS, isWatcherExhaustionError, warnWatcherFallback } from '../utility/watcherFallback.ts';

export class RootConfigWatcher extends EventEmitter {
	#configFilePath: string;
	#watcher!: FSWatcher;
	#config: any;
	#usingPolling: boolean;
	#closed: boolean;
	#openCount: number = 0;
	ready: Promise<any[]>;

	constructor() {
		super();
		this.#configFilePath = getConfigFilePath();
		this.#usingPolling = false;
		this.#closed = false;
		this.ready = once(this, 'ready');
		this.#openWatcher();
	}

	#openWatcher() {
		this.#openCount++;
		this.#watcher = chokidar
			.watch(this.#configFilePath, {
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
				// Guard against reopen-after-close: the caller may have invoked
				// close() while this teardown was in flight. The .catch is required
				// because `finally` would re-raise a teardown rejection as an
				// unhandled one.
				this.#watcher
					.close()
					.catch(() => {
						// Teardown errors on an already-failed watcher are not actionable.
					})
					.finally(() => {
						if (!this.#closed) this.#openWatcher();
					});
			}
			return;
		}
		this.emit('error', error);
	}

	handleChange() {
		readFile(this.#configFilePath, 'utf-8')
			.then((data) => {
				if (!data) return;

				const config = parse(data);

				if (!this.#config) {
					this.#config = config;
					this.emit('ready', this.#config);
					return;
				}

				this.emit('change', (this.#config = config));
			})
			.catch((_error) => {
				// if yaml parse error ignore?
			});
	}

	close() {
		this.#closed = true;
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
