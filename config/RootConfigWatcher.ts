import { FSWatcher } from 'chokidar';
import { getConfigFilePath } from './configUtils.ts';
import { readConfigFileSync } from './readConfigFileSync.ts';
import { EventEmitter, once } from 'node:events';
import { parseConfigFile } from './parseConfigFile.ts';
import {
	POLLING_FALLBACK_OPTIONS,
	claimLostNativeWatchError,
	guardedWatch,
	isWatcherExhaustionError,
	warnWatcherFallback,
} from '../utility/watcherFallback.ts';
import { resolveWatchTarget } from '../utility/watchPath.ts';
import { errorForLog, loggerWithTag } from '../utility/logging/harper_logger.ts';
import { ConfigReadRetry } from './configReadRetry.ts';
import { ArmGate } from './watcherArming.ts';

function isMissingFile(error: unknown): boolean {
	return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

// `harper_logger` imports this module at its own bottom to break their cycle, so a tagged logger
// built at module scope would run `loggerWithTag()` before `mainLogger` is initialized.
let taggedLogger: ReturnType<typeof loggerWithTag> | undefined;
function logger() {
	return (taggedLogger ??= loggerWithTag('config-watcher'));
}

export class RootConfigWatcher extends EventEmitter {
	#configFilePath: string;
	#watchPath: string;
	#watcher!: FSWatcher;
	#config: any;
	#usingPolling: boolean;
	#closed: boolean;
	#openCount: number = 0;
	#readCount: number = 0;
	#readRetry: ConfigReadRetry = new ConfigReadRetry();
	#armGate: ArmGate = new ArmGate();
	// The gate above is chokidar's scan finishing; this is the barrier's gate. A terminal outcome
	// opens it without claiming the watch is armed, so the arming re-read still runs afterwards.
	#barrierOpen: boolean = false;
	#configLoaded: boolean = false;
	#readyStaged: boolean = false;
	#readyEmitted: boolean = false;
	ready: Promise<any[]>;

	constructor() {
		super();
		this.#configFilePath = getConfigFilePath();
		const watchTarget = resolveWatchTarget(this.#configFilePath);
		this.#watchPath = watchTarget.path;
		this.#usingPolling = watchTarget.mustPoll;
		this.#closed = false;
		this.ready = once(this, 'ready');
		this.#openWatcher();
	}

	#openWatcher() {
		const generation = ++this.#openCount;
		this.#watcher = guardedWatch(this.#watchPath, {
			persistent: false,
			...(this.#usingPolling ? POLLING_FALLBACK_OPTIONS : {}),
		})
			.on('add', this.handleChange.bind(this))
			.on('change', this.handleChange.bind(this))
			.on('error', this.handleError.bind(this))
			// Generation-bound: `#armGate.reset()` runs before the failed watcher is closed, so a
			// `ready` still queued on it would arm the gate on the replacement's behalf and the
			// replacement's own `ready` would then be a no-op — leaving its scan window unre-read.
			.on('ready', () => this.#handleArmed(generation));
	}

	#handleArmed(generation: number) {
		if (this.#closed || generation !== this.#openCount) return;
		this.#armGate.arm(() => this.#markArmed());
	}

	#markArmed() {
		this.#barrierOpen = true;
		// A write that landed while the watch was unarmed was never reported, and a scan that found
		// no file at all reported nothing either, so arming always re-reads rather than publishing
		// what an earlier read staged — or, with no file, staying pending forever.
		this.#read(true);
		// A read that armed the ladder settles `ready` itself, with the newer config.
		if (!this.#readRetry.pending) this.#emitReady();
	}

	#emitReady() {
		if (this.#readyEmitted || !this.#barrierOpen || !this.#readyStaged || this.#closed) return;
		this.#readyEmitted = true;
		try {
			this.emit('ready', this.#config);
		} catch (error) {
			logger().warn('A Harper configuration listener failed', errorForLog(error));
		}
	}

	// `harper_logger.start()` awaits `ready` with no timeout, so a read that ends without a config —
	// exhausted, empty past the ladder, or unparseable — has to settle the barrier and let the
	// logger boot on its defaults. It settles with no config rather than with `{}`: an empty
	// object is a configuration that turns logging off, and a consumer cannot tell it apart from
	// one the file really carried. The warning that precedes each call is the record of what
	// failed; a later watcher event still delivers the real config as a `change`.
	#stageBootFallback() {
		if (this.#readyEmitted) return;
		this.#config = undefined;
		this.#configLoaded = false;
		this.#readyStaged = true;
		this.#emitReady();
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

	// Test-only: tells a ladder rung from a watcher event.
	get _readCountForTests(): number {
		return this.#readCount;
	}

	get _armedForTests(): boolean {
		return this.#armGate.armed;
	}

	handleError(error: unknown) {
		// A queued chokidar error can land after close(), which has dropped every listener.
		if (this.#closed) return;
		// See EntryHandler.#handleWatcherError: a lost native watch handle is benign
		// and must not be surfaced to consumers as a config-watch failure.
		if (claimLostNativeWatchError(error)) return;
		if (isWatcherExhaustionError(error)) {
			// Swallow every exhaustion error — chokidar can emit several before the
			// failed native watcher closes, and we don't want a flurry of ENOSPC to
			// surface to consumers in the middle of recovery.
			if (!this.#usingPolling) {
				warnWatcherFallback(this.#configFilePath);
				this.#usingPolling = true;
				// The generation that just failed no longer speaks for the watch; the replacement
				// arms on its own scan, and re-reads then as the first one did.
				this.#armGate.reset();
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
					.catch((error) =>
						logger().warn(`Could not reopen the ${this.#configFilePath} watch on polling`, errorForLog(error))
					);
			} else {
				// Already polling — the replacement failed too, or the watch was polling from
				// construction (`mustPoll`) and never had a fallback to take. Either way the branch
				// above reopens only once, so this is the watch's terminal outcome and the barrier
				// has to settle or `harper_logger.start()` awaits it forever.
				this.#barrierOpen = true;
				this.#stageBootFallback();
			}
			return;
		}
		// chokidar may never reach its own `ready` after a scan error, and nothing else would
		// settle the barrier: the error is this read's terminal outcome. The scan is not over
		// though, so the arm gate stays closed and a later `ready` still takes the arming re-read.
		this.#barrierOpen = true;
		this.#stageBootFallback();
		// Settling the barrier removed the `error` listener `once(this, 'ready')` attached, and an
		// emit with none left throws the error back into chokidar's dispatch — as does a consumer
		// that throws from its own handler.
		if (this.listenerCount('error') === 0) {
			logger().warn(`The Harper configuration watcher at ${this.#configFilePath} failed`, errorForLog(error));
			return;
		}
		try {
			this.emit('error', error);
		} catch (listenerError) {
			logger().warn('A Harper configuration error listener failed', errorForLog(listenerError));
		}
	}

	handleChange() {
		this.#read(true);
	}

	// `harper_logger.start()` awaits `ready` with no timeout and the ladder may be the only thing
	// left to settle it, so until then its timer keeps the thread alive rather than letting it
	// drain and exit mid-boot.
	#schedule(): boolean {
		return this.#readRetry.schedule(() => this.#read(false), !this.#readyEmitted);
	}

	#read(waitForLock: boolean) {
		// A queued chokidar callback can still land after close(), which has already discarded the
		// config and dropped every listener.
		if (this.#closed) return;
		this.#readCount++;
		let data: string;
		try {
			data = readConfigFileSync(this.#configFilePath, waitForLock);
		} catch (error) {
			// A missing file is not a lock — `readConfigFileSync` does not retry it either, and
			// `OptionsWatcher` settles it immediately as the install window. Taking the ladder here
			// would disagree with that and cost `harper_logger.start()` the whole budget on every
			// boot that has no config file (an env-var-only deployment, an empty mounted rootPath).
			if (!isMissingFile(error) && this.#schedule()) return;
			// A ladder armed by an earlier empty read is spent by the time a rung lands on ENOENT,
			// and every other terminal path clears its deadline.
			this.#readRetry.reset();
			logger().warn(
				`Unable to read the Harper configuration file at ${this.#configFilePath}` +
					(this.#configLoaded ? ', continuing with the previously loaded configuration' : '; none has been loaded yet'),
				errorForLog(error)
			);
			this.#stageBootFallback();
			return;
		}
		// See DESIGN.md, "An empty read is a writer mid-write, not an empty config".
		if (!data) {
			if (this.#schedule()) return;
			logger().warn(`The Harper configuration file at ${this.#configFilePath} is empty`);
			this.#stageBootFallback();
			return;
		}
		let config;
		try {
			config = parseConfigFile(data, this.#configFilePath);
		} catch (error) {
			// A read taken mid-write is untrustworthy, not only an empty one: the writer's first
			// `write(2)` can land a prefix of the document, and the event carrying the rest is the one
			// chokidar throttles away. So an unparseable read rides out the same ladder as an empty
			// one, and only a read that parses releases it.
			if (this.#schedule()) return;
			logger().warn((error as Error).message);
			this.#stageBootFallback();
			return;
		}
		// The third shape a mid-write read takes, and the only one that parses: a truncated
		// document, a lone `\n`, a file that is nothing but comments all yield `null` rather than
		// throwing, and adopting one hands every consumer a config with nothing in it. Same ladder
		// as the two above, and past it the file is empty rather than mid-write.
		if (!config || typeof config !== 'object') {
			if (this.#schedule()) return;
			logger().warn(`The Harper configuration file at ${this.#configFilePath} is empty`);
			this.#stageBootFallback();
			return;
		}
		this.#readRetry.reset();

		// Before `ready` goes out there is no prior state to have changed *since*.
		this.#configLoaded = true;
		this.#readyStaged = true;
		if (!this.#readyEmitted) {
			this.#config = config;
			this.#emitReady();
			return;
		}

		try {
			this.emit('change', (this.#config = config));
		} catch (error) {
			logger().warn('A Harper configuration change listener failed', errorForLog(error));
		}
	}

	close() {
		// Closing is a terminal outcome too: leaving `ready` pending would hang anything still
		// awaiting the barrier. Through `#emitReady`, so a listener that throws cannot skip the
		// teardown below it and leave the watcher and its arm timer running.
		this.#barrierOpen = true;
		this.#readyStaged = true;
		this.#emitReady();
		this.#closed = true;
		this.#readRetry.cancel();
		this.#armGate.cancel();
		// chokidar's close() is a promise; an unhandled teardown rejection would reach Node as one,
		// on the path whose whole job is to stop caring about this watcher. Same shape as the
		// exhaustion-recovery close above, and as `OptionsWatcher.close`.
		Promise.resolve(this.#watcher.close()).catch(() => {});
		this.#config = undefined;
		this.emit('close');
		this.removeAllListeners();
		return this;
	}

	get config() {
		return this.#config;
	}
}
