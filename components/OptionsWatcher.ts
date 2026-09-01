import { type Logger } from '../utility/logging/logger.ts';
import { loggerWithTag } from '../utility/logging/harper_logger.ts';
import { EventEmitter, once } from 'events';
import { type FSWatcher } from 'chokidar';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'util';
import { DEFAULT_CONFIG } from './DEFAULT_CONFIG.ts';
import { cloneDeep } from 'lodash';
import {
	POLLING_FALLBACK_OPTIONS,
	claimLostNativeWatchError,
	guardedWatch,
	isWatcherExhaustionError,
	warnWatcherFallback,
} from '../utility/watcherFallback.ts';
import { resolveWatchTarget } from '../utility/watchPath.ts';
import { overlayRootEnvConfig, isRootConfigFilename } from '../config/harperConfigEnvVars.ts';
import { readConfigFileSync } from '../config/readConfigFileSync.ts';
import { parseConfigFile } from '../config/parseConfigFile.ts';
import { ConfigReadRetry } from '../config/configReadRetry.ts';
import { ArmGate } from '../config/watcherArming.ts';

export interface Config {
	[key: string]: ConfigValue;
}

export type ConfigValue = undefined | null | string | number | boolean | Array<ConfigValue> | Config;

export type OptionsWatcherEventMap = {
	ready: [config?: ConfigValue];
	change: [key: string[], value: ConfigValue, config: ConfigValue];
	remove: [];
	error: [error: unknown];
	close: [];
};

// This is uniquely for errors coming from the chokidar watcher of the config file.
export class OptionsWatcherConfigFileError extends Error {
	constructor(configFilePath: string, error: unknown) {
		super(
			`Error watching config file ${configFilePath}: ${typeof error === 'object' && error !== null && 'message' in error ? error.message : error}`
		);
		this.name = 'OptionsWatcherConfigFileError';
	}
}

export class UninitializedOptionsWatcherError extends Error {
	constructor() {
		super(
			'OptionsWatcher has not been initialized yet. Await `ready()` or the `ready` event of the respective OptionsWatcher instance.'
		);
		this.name = 'UninitializedOptionsWatcherError';
	}
}

export class InvariantUninitializedOptionsWatcherError extends Error {
	constructor() {
		super('Invariant: OptionsWatcher has not been initialized yet. This should never happen.');
		this.name = 'InvariantUninitializedOptionsWatcherError';
	}
}

export class InvalidValueTypeError extends Error {
	constructor(keys: string[], value: unknown) {
		super(
			`Invalid value type for key ${keys.join('.')}. Expected object, string, array, number, boolean, or undefined. Received ${typeof value}.`
		);
		this.name = 'InvalidValueTypeError';
	}
}

export class KeyDoesNotExistError extends Error {
	constructor(keys: string[], key: string) {
		super(`Cannot set property ${keys.join('.')} as ${key} does not exist.`);
		this.name = 'KeyDoesNotExistError';
	}
}

export class CannotSetPropertyError extends Error {
	constructor(keys: string[]) {
		super(`Cannot set property ${keys.join('.')} as parent is not an object.`);
		this.name = 'CannotSetPropertyError';
	}
}

/**
 * Watches a YAML configuration file for changes and provides methods to access the configuration.
 *
 * @emits ready - When the configuration file is initially loaded and values are available
 * @emits change - When any value in the configuration changes (with key, new value, and full config)
 * @emits remove - When the configuration file is removed or the extension is removed from the config
 * @emits error - When an error occurs reading or parsing the file
 * @emits close - When the watcher is closed
 */
export class OptionsWatcher extends EventEmitter<OptionsWatcherEventMap> {
	#filePath: string;
	#watchPath: string;
	#watcher!: FSWatcher;
	#scopedConfig?: ConfigValue;
	#rootConfig?: Config;
	#isRootConfig: boolean;
	#synchronousRead: boolean;
	#readRetry: ConfigReadRetry = new ConfigReadRetry();
	#armGate: ArmGate = new ArmGate();
	#name: string;
	#logger: Logger;
	#usingPolling: boolean;
	#closed: boolean;
	#openCount: number = 0;
	#readCount: number = 0;
	#readSequence: number = 0;
	#appliedSequence: number = 0;
	#scopeConfigured: boolean = false;
	#armAbsence?: NodeJS.Immediate;
	#readyEmitted: boolean = false;
	#envComposeError: unknown;
	#pendingReads: Set<Promise<void>> = new Set();
	ready: Promise<any[]>;

	constructor(name: string, filePath: string, logger?: Logger, isRootConfig?: boolean) {
		super();
		this.#name = name;
		this.#filePath = filePath;
		const watchTarget = resolveWatchTarget(filePath);
		this.#watchPath = watchTarget.path;
		// Root-config watchers must see runtime env config (HARPER_SET_CONFIG et al.)
		// even when it hasn't been flushed to disk yet — see #handleChange (#1618).
		// Application scopes watch their own config.yaml and are never overlaid.
		const rootConfigFile = isRootConfigFilename(filePath);
		this.#isRootConfig = isRootConfig ?? rootConfigFile;
		this.#synchronousRead = this.#isRootConfig;
		this.#logger = logger || loggerWithTag(name);
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
			.on('add', this.#handleChange.bind(this))
			.on('change', this.#handleChange.bind(this))
			.on('error', this.#handleError.bind(this))
			.on('unlink', this.#handleUnlink.bind(this))
			// Generation-bound: `#armGate.reset()` runs before the failed watcher is closed, so a
			// `ready` still queued on it would arm the gate on the replacement's behalf and the
			// replacement's own `ready` would then be a no-op — leaving its scan window unre-read.
			.on('ready', () => this.#handleArmed(generation));
	}

	// Every root-declared plugin gets its own root-config watcher and each reads synchronously, so
	// each has the unarmed window DESIGN.md's "`ready` means the watcher is armed" describes. The
	// write that lands in it is reported by no event, so only this re-read can deliver it.
	#handleArmed(generation: number) {
		if (this.#closed || generation !== this.#openCount) return;
		this.#armGate.arm(() => this.#read(true, true));
	}

	#handleChange() {
		this.#read(true);
	}

	// While `ready` is outstanding the ladder is the only thing that can settle it, so its timer has
	// to keep the thread alive; afterwards it must not, or a config file nobody is reading would
	// hold a worker open.
	#schedule(): boolean {
		return this.#readRetry.schedule(() => this.#read(false), !this.#readyEmitted);
	}

	#read(waitForLock: boolean, arming: boolean = false) {
		// A queued chokidar callback can still land after close(), and by then removeAllListeners()
		// has run — emitting into an EventEmitter with no 'error' listener would throw out of it.
		if (this.#closed) return;
		this.#readCount++;
		if (this.#synchronousRead) {
			try {
				let contents: string;
				try {
					contents = readConfigFileSync(this.#filePath, waitForLock);
				} catch (error) {
					this.#handleReadError(error, arming);
					return;
				}
				this.#applyContents(contents);
			} catch (error) {
				// A listener of what `#applyContents` emitted may have closed the watcher, after
				// which `emit('error')` has no listener left and would throw out of here.
				if (!this.#closed) this.#surfaceFailure(error);
			}
			return;
		}

		// The `#closed` check above cannot cover the completion: close() may land while this read is
		// in flight, and by then its retry state is cancelled and its listeners are gone. Nothing
		// orders these against each other either — chokidar does not await one read before starting
		// the next — so an older one completing last would put the file's previous contents back
		// with no event left to correct it.
		const sequence = ++this.#readSequence;
		const outranked = () => this.#closed || sequence < this.#appliedSequence;
		const read: Promise<void> = readFile(this.#filePath, 'utf-8')
			.then(
				(contents) => {
					if (outranked()) return;
					this.#appliedSequence = sequence;
					this.#applyContents(contents);
				},
				(error) => {
					if (outranked()) return;
					this.#appliedSequence = sequence;
					this.#handleReadError(error, arming);
				}
			)
			.catch((error) => {
				if (!this.#closed) this.#surfaceFailure(error);
			})
			.finally(() => {
				this.#pendingReads.delete(read);
			});
		this.#pendingReads.add(read);
	}

	#applyContents(contents: string) {
		// An empty read is a writer's truncate window, not an emptied config, and falling through
		// would emit `remove` — see DESIGN.md, "An empty read is a writer mid-write, not an empty
		// config". Both read paths can land in that window; only the synchronous one is likely to.
		if (!contents) {
			if (this.#schedule()) return;
			// Past the ladder the file is empty rather than mid-write, and an empty file carries no
			// scope: keep what is already applied instead of reading it as a removal, and settle the
			// boot barrier on the defaults rather than leaving `Scope.ready` pending forever.
			this.#logger.warn?.(`Configuration file ${this.#filePath} is empty.`);
			this.#settleUnconfigured();
			return;
		}
		let parsed;
		try {
			parsed = parseConfigFile(contents, this.#filePath);
		} catch (error) {
			// A prefix of the document is as much a mid-write read as an empty one, and the event
			// carrying the rest is the one chokidar throttles away — same ladder, same reason. Past it
			// the file really is malformed, which `#read` routes to `#surfaceFailure`.
			if (!this.#closed && this.#schedule()) return;
			throw error;
		}
		// Judged on the file's own parse, before the overlay below: a truncated document, a lone
		// `\n` and a file of nothing but comments all parse to `null` rather than throwing, and
		// `overlayRootEnvConfig` turns any of them into a non-null object whenever a config env var
		// is set — the norm in containers — so overlaying first would launder a half-written file
		// into a valid-looking env-only config and wipe the file's own options. Past the ladder it
		// is an empty file, which `#applyContents` already keeps rather than reads as a removal.
		if (!parsed || typeof parsed !== 'object') {
			if (this.#schedule()) return;
			this.#logger.warn?.(`Configuration file ${this.#filePath} is empty.`);
			this.#settleUnconfigured();
			return;
		}
		this.#readRetry.reset();
		// The on-disk root config is not guaranteed to include runtime env config at
		// boot: the file flush races component loading, so a scope's boot-time reads
		// (e.g. an `enabled` gate in handleApplication) could observe pre-env values
		// the componentLoader itself never saw. Ask the config layer to overlay env
		// config onto EVERY root-config read so scope.options matches the resolved
		// view (#1618). Non-root scopes and the no-env-vars case are untouched
		// (overlayRootEnvConfig is a no-op there).
		if (this.#isRootConfig) {
			try {
				parsed = overlayRootEnvConfig(parsed);
			} catch (error) {
				this.#envComposeError = error;
				if (this.#readyEmitted) this.#reportEnvComposeFailure();
				else this.#settleUnconfigured();
				return;
			}
		}
		this.#rootConfig = parsed && typeof parsed === 'object' ? parsed : undefined;
		// If the extension is in the config file
		if (this.#rootConfig && this.#name in this.#rootConfig) {
			this.#applyScopedConfig(this.#rootConfig[this.#name]);
		} else {
			// Otherwise, if the extension is not in the config file
			// This means the plugin was removed from the config file
			// Presence, not truthiness: `myPlugin:` with nothing under it is a configured scope, and
			// deleting that block has to reach `Scope` as a removal like any other.
			if (this.#scopeConfigured) {
				this.#scopeConfigured = false;
				this.#scopedConfig = undefined;
				this.#emitRemove();
			}
			// The scope may be added back later, but this read is still a terminal outcome: with
			// nothing ever applied, neither branch above emits, and `Scope.ready` would stay pending
			// for a config that read perfectly well. The read succeeded, so only the scope falls back
			// to its default — `#settleUnconfigured`'s full reset would discard the root config this
			// very read produced.
			if (!this.#readyEmitted) {
				this.#scopedConfig = cloneDeep(DEFAULT_CONFIG[this.#name]);
				this.#emitReady(this.#scopedConfig);
			}
		}
	}

	#handleReadError(error: unknown, arming: boolean = false) {
		// If the config file does not exist
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			// A readFile ENOENT here is the install window (file not written yet) or a
			// transient read race — NOT a real deletion, which chokidar routes to
			// `#handleUnlink`. Env config is file-independent, so when it provides this
			// scope the missing file must not discard it (#1618). When it does not, fall
			// through to the original ENOENT handling with #rootConfig untouched, so a
			// first boot still emits `ready` (not `remove`, which nothing consumes at
			// boot → `ready` would hang forever).
			// A ladder armed by an earlier empty read is spent here, and every other terminal path
			// clears its deadline; leaving it armed costs the next mid-write read its whole budget.
			this.#readRetry.reset();
			if (this.#applyEnvOnlyConfig()) return;
			// And a config already exists, reset it to the default
			if (this.#rootConfig) {
				// The arm gate's job is the *write* that landed while the watch was unarmed, and
				// answering its ENOENT with a removal reports the deletion ahead of the `unlink`
				// that would confirm it — on a platform with an arming grace, ahead of chokidar
				// having finished its own teardown, so a config recreated on the strength of that
				// early `remove` lands where its `add` is not observed at all. It cannot simply be
				// dropped either: the unarmed window is exactly where an `unlink` can go missing.
				// So it goes back to the loop once, and chokidar's own `unlink` cancels it.
				if (arming) {
					this.#deferAbsenceCheck();
					return;
				}
				this.#resetConfig();
				this.#emitRemove();
			} else {
				// Otherwise, if no config exists, then just set to default and emit ready
				this.#resetConfig();
				this.#emitReady();
			}
			this.#reportEnvComposeFailure();
			return;
		}
		// A failure that outlives the read emits no new watcher event when it clears, so without
		// this the scope would hold a stale config until the next write. Both read paths: an
		// application config on SMB or under an editor's replacement returns a transient
		// EBUSY/EIO just the same, and only the read for it blocks — the ladder never does.
		if (!this.#closed && this.#schedule()) return;
		this.#surfaceFailure(error);
	}

	// A failure before anything has been applied is the boot window, where `error` alone strands the
	// component: `Scope` logs it and componentLoader waits on `Scope.ready` with no timeout. Fall
	// back to the defaults exactly as the ENOENT branch above does — and emit `ready` first, since
	// `error` settles the `once(..., 'ready')` promises both of them await.
	#surfaceFailure(error: unknown) {
		this.#settleUnconfigured();
		this.#emitError(error);
	}

	// Settling the barrier removes the `error` listener `once(this, 'ready')` attached, and an emit
	// with none left throws the error back at the caller — here, chokidar's dispatch or a retry
	// timer, where nothing can absorb it. A consumer that throws is no different.
	#emitError(error: unknown) {
		if (this.listenerCount('error') === 0) {
			this.#logger.error?.(`The configuration for '${this.#name}' at ${this.#filePath} could not be read`, error);
			return;
		}
		try {
			this.emit('error', error);
		} catch (listenerError) {
			this.#logger.error?.('A configuration error listener failed', listenerError);
		}
	}

	#emitRemove() {
		try {
			this.emit('remove');
		} catch (error) {
			this.#logger.error?.('A configuration removal listener failed', error);
		}
	}

	// `#readyEmitted`, not the config's truthiness: a scope absent from a config that read fine
	// leaves `#rootConfig` set with no `ready` behind it, and a later failure would return here
	// with `Scope.ready` still pending.
	#settleUnconfigured() {
		if (this.#readyEmitted) return;
		// A file the watcher cannot use does not unset env config, exactly as on the ENOENT path
		// (#1618) — but the barrier still has to settle, including when composing that env config is
		// itself what failed.
		if (this.#applyEnvOnlyConfig()) {
			if (!this.#readyEmitted) this.#emitReady(this.#scopedConfig);
			return;
		}
		this.#resetConfig();
		this.#emitReady(this.#scopedConfig);
		this.#reportEnvComposeFailure();
	}

	#emitReady(...args: [ConfigValue?]) {
		this.#readyEmitted = true;
		try {
			this.emit('ready', ...args);
		} catch (error) {
			// The failure paths emit `ready` from a ladder timer and from chokidar's error dispatch,
			// where a throwing listener is an uncaught exception that takes the worker down.
			this.#logger.error?.('A configuration listener failed', error);
		}
	}

	#handleError(error: unknown) {
		// See EntryHandler.#handleWatcherError: a lost native watch handle is benign
		// and must not be surfaced to consumers as a config-watch failure.
		if (claimLostNativeWatchError(error)) return;
		if (isWatcherExhaustionError(error)) {
			// Swallow every exhaustion error — chokidar can emit several before the
			// failed native watcher closes, and we don't want a flurry of ENOSPC to
			// surface to consumers in the middle of recovery.
			if (!this.#usingPolling) {
				warnWatcherFallback(this.#filePath);
				this.#usingPolling = true;
				// The generation that just failed no longer speaks for the watch; the replacement arms
				// on its own scan, and re-reads then as the first one did.
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
					.catch((error) => this.#logger.error?.(`Could not reopen the ${this.#filePath} watch on polling:`, error));
			} else {
				// Already polling — the replacement failed too, or the watch was polling from
				// construction (`mustPoll`) and never had a fallback to take. Either way the branch
				// above reopens only once, so no read will ever run: settle the barrier rather than
				// leave `Scope.ready` pending forever.
				this.#settleUnconfigured();
			}
			return;
		}
		// Terminal for this scope: `componentLoader` awaits `Scope.ready` with no timeout, and an
		// `error` emitted while it is pending rejects that barrier instead of settling it — the
		// asymmetry with `RootConfigWatcher.handleError` the boot-barrier contract cannot afford.
		const watcherError = new OptionsWatcherConfigFileError(this.#filePath, error);
		this.#settleUnconfigured();
		this.#emitError(watcherError);
	}

	#handleUnlink(path: string) {
		// The deletion settles what a pending read was retrying, and a rung landing after this
		// would find ENOENT and emit a second `remove` at consumers that treat it as teardown.
		// Same for the arming re-read's deferred absence check: this is the event it was waiting on.
		this.#readRetry.reset();
		if (this.#armAbsence) clearImmediate(this.#armAbsence);
		this.#armAbsence = undefined;
		// A real deletion still leaves env-var config in force: an env-defined scope must
		// survive it exactly as on the ENOENT read path — same fallback, same error routing
		// (#1618, #1726 review).
		if (this.#applyEnvOnlyConfig()) {
			this.#logger.warn?.(
				`Configuration file ${path} was deleted; the env-var-defined configuration for '${this.#name}' remains in effect.`
			);
			return;
		}
		this.#logger.warn?.(
			`Configuration file ${path} was deleted. Reverting to default configuration. Recreate it to restore the options watcher.`
		);
		this.#resetConfig();
		this.#emitRemove();
		this.#reportEnvComposeFailure();
	}

	/**
	 * Shared fallback for the ENOENT read path and `#handleUnlink`: when config env vars
	 * define this scope, apply the env-only overlay (first source application → `ready`;
	 * already configured → `merge`, never reset). Returns true when the event was handled —
	 * including the malformed-env case, which routes to `error` like the file-read path
	 * rather than an unhandled rejection. Returns false (root config untouched) when this
	 * is not a root config or the env config does not provide the scope, so callers keep
	 * their own reset semantics.
	 */
	#applyEnvOnlyConfig(): boolean {
		this.#envComposeError = undefined;
		if (!this.#isRootConfig) return false;
		let composed: Config | undefined;
		try {
			composed = overlayRootEnvConfig(undefined) as Config | undefined;
		} catch (composeError) {
			// Env config that cannot be composed is not env config: `false` puts every caller on the
			// path it already takes when there is none, so the barrier still settles on the defaults
			// and a deletion still emits `remove`. The failure is held for `#reportEnvComposeFailure`,
			// which callers run *after* settling — an `error` emitted first settles
			// `once(this, 'ready')` by rejection instead.
			this.#envComposeError = composeError;
			return false;
		}
		if (!composed || !(this.#name in composed)) return false;
		this.#rootConfig = composed;
		this.#applyScopedConfig(composed[this.#name]);
		return true;
	}

	#reportEnvComposeFailure() {
		if (this.#envComposeError === undefined) return;
		const error = this.#envComposeError;
		this.#envComposeError = undefined;
		this.#emitError(error);
	}

	// A scope with no source config takes `ready`, one with a prior source value takes the granular `change`
	// events `#merge` derives. `ready` is emitted more than once: a scope can go back to having no
	// config of its own — see `Scope.#handleOptionsWatcherReady` for what a repeat means there.
	#applyScopedConfig(next: ConfigValue) {
		if (!this.#scopeConfigured) {
			this.#scopeConfigured = true;
			this.#scopedConfig = next;
			this.#emitReady(this.#scopedConfig);
			return;
		}
		if (this.#scopedConfig) {
			return this.#merge(next, this.#scopedConfig);
		}
		// A falsy scope value is still a configured scope — `myPlugin:` with nothing under it is
		// the idiomatic "enable with defaults" — and `#merge` cannot diff from one, because
		// `#setValue` needs a value to walk. Re-reading it is not a transition (every ladder rung
		// and rename-burst re-read would otherwise look like one), but *filling it in* is a change
		// like any other, not the unconfigured → configured `ready` that `Scope` answers with a
		// restart.
		if (isDeepStrictEqual(next, this.#scopedConfig)) return;
		this.#scopedConfig = next;
		this.#emitChange([], next);
	}

	// Cloned, never aliased: `#merge` writes into `#scopedConfig` in place, so a scope that starts
	// on the defaults and is then configured would otherwise write the app's values into the
	// module-level `DEFAULT_CONFIG` every later reset hands out. And not configured: the six scopes
	// `DEFAULT_CONFIG` names would otherwise have the next read of an unchanged file look like the
	// block being deleted.
	#resetConfig() {
		this.#scopeConfigured = false;
		this.#rootConfig = cloneDeep(DEFAULT_CONFIG);
		this.#scopedConfig = this.#rootConfig[this.#name];
	}

	#deferAbsenceCheck() {
		if (this.#armAbsence) return;
		this.#armAbsence = setImmediate(() => {
			this.#armAbsence = undefined;
			if (!this.#closed) this.#read(true);
		});
		this.#armAbsence.unref?.();
	}

	/**
	 * This merge algorithm is best thought off as a diff and overwrite.
	 * The new config object will completely overwrite the old config object,
	 * but we need to recursively iterate over the new entries and emit the
	 * necessary change events.
	 *
	 * All events are considered to be a `change`.
	 */
	#merge(newConfigValue: ConfigValue, currentConfigValue: ConfigValue, prevKeys: string[] = []) {
		// First, ensure current and new config values are Config objects (not null, undefined, or a primitive)
		if (!this.#isConfig(currentConfigValue) || !this.#isConfig(newConfigValue)) {
			// If either is not a config, then just set as there is no need to diff/merge
			if (!isDeepStrictEqual(currentConfigValue, newConfigValue)) {
				this.#setValue(prevKeys, newConfigValue);
			}
			return;
		}

		// Check for any missing keys (new config has removed keys from current config)
		for (const key of Object.keys(currentConfigValue)) {
			if (!(key in newConfigValue)) {
				this.#setValue(prevKeys.concat(key), undefined);
			}
		}

		// Then, iterate of the keys in the new config and check for any changes to the current config
		for (const [key, newValue] of Object.entries(newConfigValue)) {
			const keys = prevKeys.concat(key);
			const currentValue = this.#getValue(keys);

			// If the new value is not the same type as the current value, then no equivalency check is necessary
			// Just set the value and continue
			if (
				typeof newValue !== typeof currentValue ||
				// one exception to the above rule is if the `currentValue` is being changed from an array to an object or vice versa
				// Check for this and shortcut as it can be treated as a type change
				(Array.isArray(newValue) && !Array.isArray(currentValue)) ||
				(!Array.isArray(newValue) && Array.isArray(currentValue))
			) {
				this.#setValue(keys, newValue);
				continue;
			}

			// If the new value is an object (non null nor an array), now merge it with the current value
			if (!Array.isArray(newValue) && typeof newValue === 'object' && newValue !== null) {
				if (this.#isConfig(currentValue)) {
					// Now we're sure currentValue is a Config
					this.#merge(newValue, currentValue, keys);
				} else {
					// If currentValue is not a Config, just set newValue
					this.#setValue(keys, newValue);
				}
				continue;
			}

			if (!isDeepStrictEqual(newValue, currentValue)) {
				this.#setValue(keys, newValue);
			}
		}
	}

	#isConfig(value: ConfigValue): value is Config {
		return typeof value === 'object' && value !== null && value !== undefined && !Array.isArray(value);
	}

	#getValue(keys: string[]): undefined | ConfigValue {
		let value: ConfigValue = this.#scopedConfig;

		for (const key of keys) {
			if (value === null || value === undefined || typeof value !== 'object' || !(key in value)) return undefined;

			value = value[key];
		}

		return cloneDeep(value);
	}

	#setValue(keys: string[], value: ConfigValue) {
		// This method is only called by `merge`, which is only called by `changeHandler` if `this.#config` is defined.
		// So this should never happen, but just in case, throw an error.
		// If this ever does get triggered:
		// - Did something else other than `merge` call this method?
		// - Did the `merge` method get called differently?
		// - Did the `merge` method become async and the `this.#config` get set to undefined sometime in between?
		if (!this.#scopedConfig) {
			throw new InvariantUninitializedOptionsWatcherError();
		}

		if (!['object', 'string', 'array', 'number', 'boolean', 'undefined'].includes(typeof value)) {
			throw new InvalidValueTypeError(keys, value);
		}

		if (keys.length === 0) {
			this.#scopedConfig = value;
			this.#emitChange(keys, value);
			return;
		}

		let obj: ConfigValue = this.#scopedConfig;

		for (const key of keys.slice(0, -1)) {
			if (obj === null || obj === undefined || typeof obj !== 'object' || !(key in obj)) {
				throw new KeyDoesNotExistError(keys, key);
			}

			obj = obj[key];
		}

		if (obj === null || obj === undefined || typeof obj !== 'object') {
			throw new CannotSetPropertyError(keys);
		}

		obj[keys[keys.length - 1]] = value;

		this.#emitChange(keys, value);
	}

	// `#merge` runs inside chokidar's own dispatch on the unlink and env-fallback paths, where a
	// plugin's `change` handler throwing would leave the worker with an uncaught exception on a
	// config event the watcher had just decided to survive. It still reaches consumers as `error`
	// — a listener fault is not a read fault, which is why it must not reach `#handleReadError`.
	#emitChange(keys: string[], value: ConfigValue) {
		try {
			this.emit('change', keys, value, this.#scopedConfig);
		} catch (error) {
			this.#emitError(error);
		}
	}

	// Test-only: simulate the underlying chokidar watcher emitting an error.
	// Exposed so the polling-fallback path can be exercised without triggering a
	// real ENOSPC/EMFILE on the host.
	_simulateWatcherErrorForTests(error: unknown): void {
		this.#handleError(error);
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

	// Test-only: tells a ladder rung from a watcher event.
	get _readCountForTests(): number {
		return this.#readCount;
	}

	get _armedForTests(): boolean {
		return this.#armGate.armed;
	}

	// Test-only: read now, rather than at whatever granularity a chokidar event would arrive.
	_refreshForTests(arming: boolean = false): Promise<unknown> {
		this.#read(true, arming);
		return Promise.allSettled([...this.#pendingReads]);
	}

	/**
	 * Closes the underlying file watcher and drains any pending config-file reads.
	 * Emits `close` synchronously, removes all listeners, then returns a Promise that
	 * resolves once the chokidar watcher has fully stopped and all in-flight reads settle.
	 */
	close(): Promise<this> {
		// Terminal like every other outcome, and `Scope.ready` has no timeout. Before `#closed` and
		// through `#emitReady`, so a listener that throws cannot skip the teardown below it.
		this.#settleUnconfigured();
		this.#closed = true;
		this.#readRetry.cancel();
		this.#armGate.cancel();
		if (this.#armAbsence) clearImmediate(this.#armAbsence);
		this.#armAbsence = undefined;
		const pendingReads = [...this.#pendingReads];
		const watcherClose = Promise.resolve(this.#watcher.close()).catch(() => {});

		this.emit('close');
		this.removeAllListeners();

		return Promise.allSettled([watcherClose, ...pendingReads]).then(() => this);
	}

	/**
	 * Get a value from the configuration using an array of strings representing the key.
	 *
	 * For example, if the configuration is:
	 * ```yaml
	 * foo:
	 *  bar:
	 *   baz: 42
	 * ```
	 * Then `get(['foo','bar','baz'])` will return `42`.
	 *
	 * If the key does not exist, `undefined` will be returned.
	 * @param key an array of strings representing the key.
	 * @returns
	 */
	get(key: string[]): ConfigValue | undefined {
		return this.#scopedConfig ? this.#getValue(key) : undefined;
	}

	/**
	 * Get the entire configuration object.
	 *
	 * @returns A deep clone of the entire configuration object.
	 */
	getAll(): ConfigValue | undefined {
		return cloneDeep(this.#scopedConfig);
	}

	/**
	 * Get the entire root configuration object from the config file.
	 */
	getRoot(): Config | undefined {
		return this.#rootConfig;
	}

	// Not sure if we want to enable runtime changes to the config - any changes to the config should be done in the config file.
	// /**
	//  * Set a value in the configuration using a dot-separated key. Any existing value can be replaced with any new value, regardless of type.
	//  *
	//  * For example, with the configuration:
	//  *
	//  * ```yaml
	//  * foo:
	//  *  bar:
	//  *   baz: 42
	//  * ```
	//  *
	//  * The call `set('foo.bar.baz', 'harper')` will set `foo.bar.baz` to `'harper'`.
	//  *
	//  * This method will allow you to set new values in the configuration, but it will not generate nested objects.
	//  *
	//  * For example, using the configuration above, `set('foo.fuzz', 'buzz')`, will work fine.
	//  *
	//  * But `set('foo.x.y', 0)` will throw an error, because it is attempting to set `y` on the non-existent `x`.
	//  *
	//  * This method will emit a `change` event when the value is set.
	//  *
	//  * @param key Dot-separated key to set the value for.
	//  * @param value Value to set.
	//  */
	// set(key: string, value: any) {
	// 	this.setValue(key.split('.'), cloneDeep(value));
	// }
}
