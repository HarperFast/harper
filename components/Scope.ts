import { type Logger } from '../utility/logging/logger.ts';
import { loggerWithTag } from '../utility/logging/harper_logger.ts';
import { EventEmitter, once } from 'node:events';
import { databaseEventsEmitter, scopedTableFactory } from '../resources/databases.ts';
import { server, type Server } from '../server/Server.ts';
import { EntryHandler, type EntryHandlerEventMap, type onEntryEventHandler } from './EntryHandler.ts';
import { OptionsWatcher, type OptionsWatcherEventMap } from './OptionsWatcher.ts';
import { resources, type Resources } from '../resources/Resources.ts';
import { Models, models as modelsSingleton } from '../resources/models/Models.ts';
import type { FileAndURLPathConfig } from './Component.ts';
import { type FilesOption } from './deriveGlobOptions.ts';
import { requestRestart } from './requestRestart.ts';
import { resolveBaseURLPath } from './resolveBaseURLPath.ts';
import { composeMountedUrlPath, type ScopeMount } from './scopeMount.ts';
import { ApplicationScope } from './ApplicationScope.ts';
import {
	getSecretsForComponent,
	retainComponentSubscriptions,
	releaseComponentSubscriptions,
} from './componentSecrets.ts';
import type { SecretsView } from './componentSecrets.ts';
import { deployLifecycle } from './deployLifecycle.ts';
import { settleBeforeDeadline } from '../utility/when.ts';
import { thisThreadOwnsApplication } from '../server/threads/isolatedApplications.ts';

export class MissingDefaultFilesOptionError extends Error {
	constructor() {
		super('No default files option exists. Ensure `files` is specified in config.yaml');
		this.name = 'MissingDefaultFilesOptionError';
	}
}

export type ScopeEventsMap = {
	'all': [...args: unknown[]];
	'close': [];
	'error': [error: unknown];
	'ready': [];
	// Fired on this scope just before deploy I/O begins for the parent component
	// (extract + npm install). Plugins observing these can pause their own
	// file-driven work to avoid acting on intermediate states.
	'deploy:start': [componentName: string];
	// Fired after deploy I/O completes (success or failure), or, for a deploy
	// a canary certifies, once its rollout ends, so a worker the rollout
	// replaces may never see it. The scope's
	// EntryHandlers have been resumed by this point; their replacement watcher
	// generation compares the post-deploy scan with the retained pre-deploy
	// snapshot, so subsequent events are the logical differences of that tree,
	// not a replay of every surviving file as an `add`.
	'deploy:end': [componentName: string];
	[record: string]: [...args: unknown[]];
};

type CloseScopeOptions = {
	listenerTimeoutMs?: number;
	keepFailedEntryWatchers?: boolean;
};

type RecoveryState = {
	handlers: Set<EntryHandler>;
	cleanup: () => void;
};

const recoveryWatchersByComponent = new Map<string, RecoveryState>();

let closeScopeInternal: (scope: Scope, options?: CloseScopeOptions) => Promise<Scope>;

/** @internal */
export function closeScope(scope: Scope, options?: CloseScopeOptions): Promise<Scope> {
	return closeScopeInternal(scope, options);
}

/**
 * This class is what is passed to the `handleApplication` function of an extension.
 *
 * It is imperative that the instance is "ready" before it's passed to the `handleApplication` function
 * so that the developer can immediately start using `scope.options`, etc.
 *
 */
export class Scope extends EventEmitter<ScopeEventsMap> {
	static {
		closeScopeInternal = (scope: Scope, options?: CloseScopeOptions) => scope.#closeWithOptions(options);
	}
	#configFilePath: string;
	#directory: string;
	#appName: string;
	#pluginName: string;
	#origin: string;
	#entryHandler?: EntryHandler;
	#entryHandlers: EntryHandler[];
	#failedEntryHandlers: Set<EntryHandler> = new Set();
	#recoveryCleanup: (() => void) | undefined;
	#recoveryRestartPending: boolean = false;
	#logger: Logger;
	#secretsReleased = false;
	#pendingInitialLoads: Set<Promise<void>>;
	#deployStartHandler: (name: string) => void;
	#deployEndHandler: (name: string) => void;
	#deployInFlight: boolean = false;
	#restartRequestedDuringDeploy: boolean = false;
	#optionsReady: boolean = false;
	#closed: boolean = false;
	#closeBounded: boolean = false;
	#closing: Promise<this> | undefined;
	#pendingCloseListeners: Promise<unknown> | undefined;
	#bearerValidatorsDisposed: boolean = false;
	#bearerValidatorDisposers: Array<() => void> = [];
	applicationScope?: ApplicationScope;

	options: OptionsWatcher;
	resources?: Resources;
	server?: Server;
	ready: Promise<any[]>;
	databaseEvents: typeof databaseEventsEmitter;
	models: Models;
	/**
	 * Routing the operator declared for this application in the root config. Applied automatically
	 * to handlers registered through `scope.server`, so plugins normally don't touch it — the
	 * router strips the mount before a handler runs and everything inside the application
	 * addresses itself mount-relative.
	 *
	 * Read it only when a plugin emits an absolute URL back to the client (e.g. a redirect
	 * `Location`, via `externalBasePath()`) or bypasses the routed chain entirely (legacy
	 * fastify routes register on the bare server).
	 */
	mount?: ScopeMount;

	constructor(
		appName: string,
		pluginName: string,
		directory: string,
		configFilePath: string,
		applicationScope: ApplicationScope,
		origin: string = appName,
		isRootConfig?: boolean,
		mount?: ScopeMount
	) {
		super();

		this.mount = mount;
		this.#appName = appName;
		this.#pluginName = pluginName;
		this.#origin = typeof origin === 'string' ? origin : appName;
		this.#directory = directory;
		this.#configFilePath = configFilePath;
		this.#logger = loggerWithTag(this.#appName);
		this.#deployInFlight = deployLifecycle.loadsAwaitDeploy(this.#appName);
		const priorRecovery = recoveryWatchersByComponent.get(this.#recoveryKey());
		if (priorRecovery) {
			priorRecovery.cleanup();
			for (const handler of priorRecovery.handlers) {
				void handler.close();
			}
		}

		this.databaseEvents = databaseEventsEmitter;
		this.applicationScope = applicationScope;
		// Hold this identity's live secret subscriptions (#1776) for as long as this Scope is open, so one
		// Scope of the identity closing can't tear down the streams of another that is still running.
		retainComponentSubscriptions(applicationScope?.name ?? appName);
		this.resources = applicationScope?.resources ?? resources;
		this.models = modelsSingleton;

		const baseServer = applicationScope?.server ?? server;
		const scopeRef = this;
		// Wrap server so http/request/ws/upgrade calls automatically carry this plugin's name,
		// urlPath, and host — enabling routing and before/after dependencies on named middleware.
		this.server = new Proxy(baseServer, {
			get(target, prop, receiver) {
				if (prop === 'http' || prop === 'request' || prop === 'ws' || prop === 'upgrade') {
					const method = Reflect.get(target, prop, receiver);
					if (typeof method === 'function') {
						return (listener: any, options?: any) => {
							return method.call(target, listener, {
								name: pluginName,
								...options,
								...scopeRef.routeFor(options),
							});
						};
					}
				}
				if (prop === 'registerBearerValidator') {
					const method = Reflect.get(target, prop, receiver);
					if (typeof method === 'function') {
						return (validator: any, options?: any) => {
							if (scopeRef.#closed || scopeRef.#bearerValidatorsDisposed) {
								throw new Error(`Cannot register a Bearer validator on closed scope ${pluginName}`);
							}
							const dispose = method.call(target, validator, options);
							if (typeof dispose === 'function') scopeRef.#bearerValidatorDisposers.push(dispose);
							return dispose;
						};
					}
				}
				return Reflect.get(target, prop, receiver);
			},
		}) as Server;

		this.#entryHandlers = [];
		this.#pendingInitialLoads = new Set();

		this.ready = once(this, 'ready');

		// Create the options instance for the scope immediately
		// isRootConfig is the loader's authoritative isRoot signal — it decides whether the
		// watcher overlays runtime env config (#1618). When a caller doesn't provide it,
		// OptionsWatcher falls back to its root-config filename heuristic.
		this.options = new OptionsWatcher(pluginName, configFilePath, this.#logger, isRootConfig)
			.on('error', this.#handleError.bind(this))
			.on('change', this.#optionsWatcherChangeListener.bind(this)())
			.on('remove', this.#optionsWatcherRemoveListener())
			.on('ready', this.#handleOptionsWatcherReady.bind(this));

		// Bridge cross-thread deploy lifecycle events for this component. The
		// handlers live on the scope for the lifetime of the scope and are torn
		// down in close().
		this.#deployStartHandler = (name) => {
			if (name === this.#appName) this.#onDeployStart(name);
		};
		this.#deployEndHandler = (name) => {
			if (name === this.#appName) this.#onDeployEnd(name);
		};
		deployLifecycle.on('deploy:start', this.#deployStartHandler);
		deployLifecycle.on('deploy:end', this.#deployEndHandler);
	}

	get logger(): Logger {
		return this.#logger;
	}

	/**
	 * The application's secrets view (#1550): hdb_secret rows granted to this application plus its
	 * declared global-tier env names. A live, read-only view (#1776) — scoped values reflect the latest
	 * store state on each read and it carries the reserved `subscribe(name)` method. Keyed by the
	 * ApplicationScope's name (the application directory name — the identity grants and env declarations
	 * use, and the same binding `import { secrets } from 'harper'` resolves); `#appName` can differ on
	 * paths like RUN_HDB_APP, where it is the full directory path.
	 */
	get secrets(): SecretsView {
		return getSecretsForComponent(this.applicationScope?.name ?? this.#appName);
	}

	get appName(): string {
		return this.#appName;
	}

	get pluginName(): string {
		return this.#pluginName;
	}

	/**
	 * Turns a mount-relative base path into the absolute path a client sees, by prefixing the
	 * application's mount. Use it for anything sent back to the client — a redirect `Location`, a
	 * generated link — since the router strips the mount before a handler runs and a handler's own
	 * view of the path therefore excludes it.
	 */
	externalBasePath(baseURLPath: string): string {
		return this.mount?.urlPath ? `${this.mount.urlPath}${baseURLPath}` : baseURLPath;
	}

	/**
	 * The route a handler registered through `scope.server` with these options will answer on — the
	 * single place the application mount is applied. `scope.server` uses it, and a plugin that must
	 * identify its own route (e.g. REST deduplicating registration per mount) calls it rather than
	 * recomposing the parts, so there is one definition of "which route is this".
	 *
	 * An explicit call option wins over config, but either way `urlPath` is *resolved* rather than
	 * passed through: plugins that spread their whole config section into these options (REST does)
	 * would otherwise hand the router a raw value — './' became the literal, unmatchable route '/.'.
	 */
	routeFor(options?: { urlPath?: string; host?: string }): { host?: string; urlPath?: string } {
		const scopeConfig = (this.options?.getAll() as any) ?? {};
		const rawUrlPath = options?.urlPath ?? scopeConfig.urlPath;
		// resolve to the same base the entry pipeline uses ('assets' -> '/assets/', './x' ->
		// '/<name>/x/') so route matching sees a real pathname prefix (#1583), then prefix the
		// application's mount. The mount is applied ONLY here, at the routing boundary: the router
		// strips it before the handler runs, so entry URL paths — and the resource paths
		// graphqlSchema/jsResource derive from them — stay mount-relative.
		const pluginUrlPath = rawUrlPath ? resolveBaseURLPath(this.#pluginName, rawUrlPath) : undefined;
		return {
			host: this.mount?.host || options?.host || scopeConfig.host || undefined,
			urlPath: composeMountedUrlPath(this.mount?.urlPath, this.#pluginName, pluginUrlPath) || undefined,
		};
	}

	get directory(): string {
		return this.#directory;
	}

	get configFilePath(): string {
		return this.#configFilePath;
	}

	ensureTable<TableResourceType = unknown>(options: any): TableResourceType {
		options.origin = this.#origin;
		return scopedTableFactory(
			this.applicationScope?.branches,
			thisThreadOwnsApplication(this.applicationScope?.name)
		)<TableResourceType>(options);
	}

	#handleOptionsWatcherReady(): void {
		// This previously created the default entry handler immediately, but now we wait for the user to call `handleEntry`
		// The issue was that since the component loader was awaiting `scope.ready()` and then calling `pluginModule.handleApplication(scope)`,
		// the default entry handler could start receiving events before the plugin provided its own handler.
		// We could make the user call `await scope.ready()` in their `handleApplication` function, but that could lead to the same issue and it'd
		// be harder for the user to understand why.

		// A second `ready` means the scope had no config of its own and now does — a config file
		// that was unreadable when this worker booted, or one recreated after deletion. Re-emitting
		// reaches nobody: componentLoader is long past its `await scope.ready`, so the component is
		// running on the defaults until something restarts it. Same recovery as the `remove`
		// listener, and the same convention — a plugin with its own `ready` handler owns it.
		const started = this.#optionsReady;
		this.#optionsReady = true;
		const restartNeeded = started && this.listenerCount('ready') === 0;

		this.emit('ready');

		if (restartNeeded) {
			this.#logger.debug?.('Options arrived after the scope started, requesting restart');
			this.requestRestart();
		}
	}

	#handleError(error: unknown): void {
		if (this.listenerCount('error') > 0) this.emit('error', error);
		else this.#logger.error?.('Error in component scope:', error);
	}

	get closed(): boolean {
		return this.#closed;
	}

	close(): Promise<this> {
		return this.#closeWithOptions();
	}

	#recoveryKey(): string {
		return `${this.#appName}\0${this.#pluginName}\0${this.#directory}\0${this.#configFilePath}`;
	}

	#releaseRecoveryWatcher(handler: EntryHandler): void {
		this.#failedEntryHandlers.delete(handler);
		const key = this.#recoveryKey();
		const registered = recoveryWatchersByComponent.get(key);
		if (registered) {
			registered.handlers.delete(handler);
			if (registered.handlers.size === 0 && !this.#recoveryRestartPending) {
				registered.cleanup();
			}
		}
		void handler.close();
	}

	#takeRecoveryWatchers(): EntryHandler[] {
		const remaining = [...this.#failedEntryHandlers];
		this.#failedEntryHandlers.clear();
		this.#recoveryCleanup?.();
		const key = this.#recoveryKey();
		const registered = recoveryWatchersByComponent.get(key);
		if (registered) {
			for (const handler of remaining) registered.handlers.delete(handler);
			if (registered.handlers.size === 0) registered.cleanup();
		}
		return remaining;
	}

	#closeWithOptions(options?: CloseScopeOptions): Promise<this> {
		let closing = (this.#closing ??= this.#close(options));
		const closeRecovery =
			!options?.keepFailedEntryWatchers && (this.#failedEntryHandlers.size > 0 || this.#recoveryCleanup !== undefined);
		const waitForListeners =
			options?.listenerTimeoutMs === undefined && (this.#pendingCloseListeners !== undefined || this.#closeBounded);
		if (closeRecovery || waitForListeners) {
			if (waitForListeners) this.#closeBounded = false;
			const remaining = closeRecovery ? this.#takeRecoveryWatchers() : [];
			const finishClose = async () => {
				const tasks: Promise<unknown>[] = remaining.map((h) => h.close());
				if (options?.listenerTimeoutMs === undefined && this.#pendingCloseListeners) {
					tasks.push(this.#pendingCloseListeners);
				}
				if (tasks.length > 0) {
					const keepAlive = setInterval(() => {}, 60_000);
					try {
						await Promise.allSettled(tasks);
					} finally {
						clearInterval(keepAlive);
					}
				}
			};
			closing = this.#closing = closing.then(
				async () => {
					await finishClose();
					return this;
				},
				async (error) => {
					await finishClose();
					throw error;
				}
			);
		}
		return closing;
	}

	async #close(options?: CloseScopeOptions): Promise<this> {
		const listenerTimeoutMs = options?.listenerTimeoutMs;
		const keepFailedEntryWatchers = options?.keepFailedEntryWatchers === true;
		this.#closed = true;
		this.#closeBounded = listenerTimeoutMs !== undefined;
		deployLifecycle.off('deploy:start', this.#deployStartHandler);
		deployLifecycle.off('deploy:end', this.#deployEndHandler);

		// Only an `EntryHandler` whose own initial file scan rejected (`#failedEntryHandlers`) is kept as a
		// one-shot recovery watcher so editing the broken file still requests a restart (#2432).
		const entryHandlersToClose = keepFailedEntryWatchers
			? this.#entryHandlers.filter((h) => !this.#failedEntryHandlers.has(h))
			: this.#entryHandlers;
		if (!keepFailedEntryWatchers) {
			this.#takeRecoveryWatchers();
		} else if (this.#failedEntryHandlers.size > 0 || this.#recoveryRestartPending) {
			const key = this.#recoveryKey();
			const handlers = new Set(this.#failedEntryHandlers);
			const onRecoveryDeployStart = (name: string) => {
				if (name !== this.#appName) return;
				for (const handler of this.#failedEntryHandlers) {
					handler.pause();
				}
			};
			const onRecoveryDeployEnd = (name: string) => {
				if (name !== this.#appName) return;
				const restartPending = this.#recoveryRestartPending;
				this.#recoveryRestartPending = false;
				for (const handler of this.#failedEntryHandlers) {
					void handler.resume().catch(() => {});
				}
				if (restartPending) {
					if (this.#failedEntryHandlers.size === 0) this.#recoveryCleanup?.();
					requestRestart();
				}
			};
			const cleanup = () => {
				deployLifecycle.off('deploy:start', onRecoveryDeployStart);
				deployLifecycle.off('deploy:end', onRecoveryDeployEnd);
				this.#recoveryRestartPending = false;
				if (this.#recoveryCleanup === cleanup) this.#recoveryCleanup = undefined;
				if (recoveryWatchersByComponent.get(key)?.cleanup === cleanup) {
					recoveryWatchersByComponent.delete(key);
				}
			};
			this.#recoveryCleanup = cleanup;
			recoveryWatchersByComponent.set(key, { handlers, cleanup });
			deployLifecycle.on('deploy:start', onRecoveryDeployStart);
			deployLifecycle.on('deploy:end', onRecoveryDeployEnd);
			if (!deployLifecycle.loadsAwaitDeploy(this.#appName)) {
				for (const handler of this.#failedEntryHandlers) {
					void handler.resume().catch(() => {});
				}
			}
		}
		await Promise.allSettled([...entryHandlersToClose.map((h) => h.close()), this.options.close()]);

		// Invoke `close` listeners and await any promise they return. A plugin's teardown can be async —
		// e.g. @harperfast/vite disposing its Vite/rolldown dev server — and the worker shutdown path
		// awaits this close(), so awaiting the listeners here ensures such a native runtime is fully
		// disposed before the worker exits. That ordering matters: tearing the worker down while a native
		// (N-API) bundler runtime is still live crashes the whole process. A later unbounded close on
		// worker SHUTDOWN still awaits any listener that outlived a failed-load time limit.
		const closeListeners = this.listeners('close') as Array<(...args: any[]) => unknown>;
		this.removeAllListeners('close');
		try {
			let firstRejection: { reason: unknown } | undefined;
			let timedOut = false;
			const listenerPromises = closeListeners.map((listener) => {
				// Run every listener (so all teardown is attempted) and bind `this` to the Scope, matching
				// how EventEmitter invokes listeners — a listener may rely on it (e.g. `this.logger`).
				let outcome: Promise<unknown>;
				try {
					outcome = Promise.resolve(listener.call(this));
				} catch (error) {
					outcome = Promise.reject(error);
				}
				return outcome.catch((error) => {
					if (timedOut) {
						this.#logger.error?.(`Error in close listener for ${this.#pluginName} after timeout:`, error);
					} else {
						firstRejection ??= { reason: error };
					}
				});
			});
			const allSettled = Promise.all(listenerPromises);
			const trackedListeners = allSettled.then(() => {
				if (this.#pendingCloseListeners === trackedListeners) {
					this.#pendingCloseListeners = undefined;
				}
			});
			if (closeListeners.length > 0) this.#pendingCloseListeners = trackedListeners;
			if (listenerTimeoutMs !== undefined) {
				await settleBeforeDeadline([allSettled], Date.now() + listenerTimeoutMs, () => {
					timedOut = true;
					this.#logger.warn?.(
						`Timed out after ${listenerTimeoutMs}ms waiting for component scope ${this.#pluginName} to close`
					);
					return new Error('scope close timed out');
				}).catch(() => {});
			} else {
				await allSettled;
			}
			if (firstRejection) throw firstRejection.reason;
		} finally {
			this.removeAllListeners();

			// Release this identity's subscription hold (#1776), after the close listeners settle (or once
			// `listenerTimeoutMs` expires on a bounded close, so a hung listener cannot pin the hold). Streams
			// end only when the LAST holder of the identity releases — so a discarded validation-load Scope
			// can't kill a still-running app's streams. Guarded so a double close() can't underflow the refcount.
			if (!this.#secretsReleased) {
				this.#secretsReleased = true;
				releaseComponentSubscriptions(this.applicationScope?.name ?? this.#appName);
			}
		}

		return this;
	}

	#onDeployStart(componentName: string): void {
		this.#deployInFlight = true;
		this.#restartRequestedDuringDeploy = false;
		this.applicationScope?.beginDeploy();
		// Pause each EntryHandler so it stops emitting events for the
		// intermediate filesystem state the deploy is writing, and so it
		// releases its inotify handles while npm install is unpacking
		// dependencies. pause() preserves the EntryHandler INSTANCE — listeners
		// the plugin attached via scope.handleEntry(handler) remain attached.
		for (const entryHandler of this.#entryHandlers) {
			entryHandler.pause();
		}

		this.#safeEmit('deploy:start', componentName);
	}

	#onDeployEnd(componentName: string): void {
		this.#deployInFlight = false;
		const restartRequestedDuringDeploy = this.#restartRequestedDuringDeploy;
		this.#restartRequestedDuringDeploy = false;

		// Resume before notifying plugins so a throwing deploy:end listener cannot strand the watchers.
		for (const entryHandler of this.#entryHandlers) {
			void entryHandler.resume().catch(() => {});
		}
		if (restartRequestedDuringDeploy) this.requestRestart();
		void this.applicationScope
			?.finishDeploy()
			.then((runtimeChanged) => {
				if (runtimeChanged) this.requestRestart();
			})
			.catch((error) => {
				this.#logger.error?.(`Could not verify the loaded runtime after deploying ${this.#appName}:`, error);
				this.requestRestart();
			});

		this.#safeEmit('deploy:end', componentName);
	}

	#safeEmit(event: 'deploy:start' | 'deploy:end', componentName: string): void {
		try {
			this.emit(event, componentName);
		} catch (error) {
			this.#logger.error?.(`Listener for ${event} threw for ${this.#appName}:`, error);
		}
	}

	#createEntryHandler(config: FilesOption | FileAndURLPathConfig): EntryHandler {
		if (this.#closed) {
			throw new Error(`Cannot handle entries on closed scope ${this.#pluginName}`);
		}
		const entryHandler = new EntryHandler(this.#pluginName, this.#directory, config, this.#logger)
			.on('error', this.#handleError.bind(this))
			.on('add', this.#defaultEntryHandlerListener('add'))
			.on('change', this.#defaultEntryHandlerListener('change'))
			.on('unlink', this.#defaultEntryHandlerListener('unlink'))
			.on('addDir', this.#defaultEntryHandlerListener('addDir'))
			.on('unlinkDir', this.#defaultEntryHandlerListener('unlinkDir'));
		if (this.#deployInFlight) entryHandler.pause();

		this.#entryHandlers.push(entryHandler);

		return entryHandler;
	}

	#defaultEntryHandlerListener(event: keyof EntryHandlerEventMap) {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const scope = this;
		return function (this: EntryHandler) {
			if (this.listenerCount('all') > 0 || this.listenerCount(event) > 1) {
				return;
			}

			if (scope.#closed || scope.#failedEntryHandlers.has(this)) {
				const deferRestart = deployLifecycle.loadsAwaitDeploy(scope.#appName);
				if (deferRestart) {
					scope.#recoveryRestartPending = true;
				}
				scope.#releaseRecoveryWatcher(this);
				if (!deferRestart) {
					requestRestart();
				}
				return;
			}

			scope.requestRestart();
		};
	}

	#optionsWatcherChangeListener() {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const scope = this;
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		return function handleOptionsWatcherChange(
			this: OptionsWatcher,
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			...[key, _, config]: OptionsWatcherEventMap['change']
		) {
			if (key[0] === 'files' || key[0] === 'urlPath') {
				// TODO: validate options

				// If no entry handler exists yet, the plugin's handleApplication has not called
				// handleEntry() yet — or it hasn't been called at all for this scope. Either way,
				// when handleEntry() is eventually called it will read the current config via
				// getFilesOption() and create the handler with the correct, up-to-date values.
				// Eagerly creating an entry handler here would start chokidar's initial scan
				// before the plugin's callback is attached, causing the initial `add` events to
				// be missed (RE-8).
				if (!scope.#entryHandler) {
					return;
				}

				void scope.#entryHandler.update(config as FileAndURLPathConfig).catch(() => {});

				return;
			}

			// If the user isn't handling option changes, request a restart
			if (this.listenerCount('change') > 1) {
				return;
			}

			scope.#logger.debug?.(`Options changed: ${key.join('.')}, requesting restart`);
			scope.requestRestart();
		};
	}

	#optionsWatcherRemoveListener() {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const scope = this;
		// Deleting a component's config block emits `remove` (not `change`), so without
		// this listener a running component keeps serving until some unrelated restart —
		// even though absence is the canonical disabled state for opt-in built-ins like
		// the /v1 models gateway. Mirrors the change listener: a plugin that registers
		// its own `remove` handler owns the response and no restart is requested.
		return function handleOptionsWatcherRemove(this: OptionsWatcher) {
			if (this.listenerCount('remove') > 1) {
				return;
			}
			scope.#logger.debug?.('Options removed, requesting restart');
			scope.requestRestart();
		};
	}

	#getFilesOption(): FileAndURLPathConfig | undefined {
		const config = this.options.getAll();
		if (
			config &&
			typeof config === 'object' &&
			config !== null &&
			!Array.isArray(config) &&
			'files' in config /*&& validate config.files*/
		) {
			return {
				files: config.files as FilesOption,
				urlPath: config.urlPath as string | undefined,
			};
		}
		return undefined;
	}

	handleEntry(files: FilesOption | FileAndURLPathConfig, handler: onEntryEventHandler): EntryHandler;
	handleEntry(handler: onEntryEventHandler): EntryHandler;
	handleEntry(): EntryHandler;
	handleEntry(
		filesOrHandler?: FilesOption | FileAndURLPathConfig | onEntryEventHandler,
		handler?: onEntryEventHandler
	): EntryHandler {
		if (this.#closed) {
			throw new Error(`Cannot handle entries on closed scope ${this.#pluginName}`);
		}
		let entryHandler: EntryHandler;

		// Helper to wrap async handlers for tracking
		const wrapHandler = (
			targetEntryHandler: EntryHandler,
			entryEventHandler: onEntryEventHandler
		): onEntryEventHandler => {
			// Retained until the drain below reports them: an operation dropped as it settles is invisible
			// to that drain, so a handler rejecting before `ready` would report nothing at all.
			let initialOperations: Promise<void>[] | null = [];

			const wrapped: onEntryEventHandler = (entry) => {
				let result;
				try {
					result = entryEventHandler(entry);
				} catch (error) {
					// A synchronous throw is the same failure as a rejection. Left to propagate, EntryHandler
					// catches it for its own reporting and the initial load completes as if nothing failed.
					result = Promise.reject(error);
				}
				if (result instanceof Promise) {
					const tracked = result.catch((error) => {
						this.#logger.error?.('Error in async entry handler:', error);
						try {
							this.#handleError(error);
						} catch (reportingError) {
							// Reporting must not replace the failure it is reporting.
							this.#logger.error?.('Error reporting an entry handler failure:', reportingError);
						}
						throw error;
					});
					// Nothing awaits `tracked` until the drain, which leaves an early rejection unhandled.
					tracked.catch(() => {});
					initialOperations?.push(tracked);
				}
			};

			// When the entry handler's initial scan completes, wait for all of its async operations
			const initialLoadPromise = once(targetEntryHandler, 'ready').then(async () => {
				const operations = initialOperations ?? [];
				initialOperations = null;
				// Drained, not fail-fast: the loader holds the plugin-wide load lock until this settles, so a
				// first failure reported while a sibling still runs would let the next application in.
				for (const result of await Promise.allSettled(operations)) {
					if (result.status === 'rejected') {
						// Let a subsequent edit fall through to `#defaultEntryHandlerListener` (#2432).
						targetEntryHandler.off('all', wrapped);
						if (!this.#closed) this.#failedEntryHandlers.add(targetEntryHandler);
						throw result.reason;
					}
				}
				targetEntryHandler.emit('initialLoadComplete');
			});

			// Track this promise so the component loader can await it
			this.#pendingInitialLoads.add(initialLoadPromise);
			// Two-branch cleanup, not `.finally`: its derivative would reject with nobody left to handle it.
			const forgetInitialLoad = () => {
				this.#pendingInitialLoads.delete(initialLoadPromise);
			};
			initialLoadPromise.then(forgetInitialLoad, forgetInitialLoad);

			return wrapped;
		};

		// No arguments
		if (filesOrHandler === undefined) {
			// If entry handler already exists, return it
			if (this.#entryHandler) {
				entryHandler = this.#entryHandler;
			} else {
				// Otherwise, try to create a default entry handler using the files option
				const filesOption = this.#getFilesOption();
				if (filesOption) {
					this.#entryHandler = this.#createEntryHandler(filesOption);
					entryHandler = this.#entryHandler;
				} else {
					this.emit('error', new MissingDefaultFilesOptionError());
					return;
				}
			}
		}
		// Provided a handler function
		else if (typeof filesOrHandler === 'function') {
			// If an entry handler already exists, return it with the handler attached
			if (this.#entryHandler) {
				entryHandler = this.#entryHandler;
			} else {
				// Otherwise, try to create a default entry handler using the files option
				const filesOption = this.#getFilesOption();
				if (filesOption) {
					this.#entryHandler = this.#createEntryHandler(filesOption);
					entryHandler = this.#entryHandler;
				} else {
					this.emit('error', new MissingDefaultFilesOptionError());
					return;
				}
			}

			const wrappedHandler = wrapHandler(entryHandler, filesOrHandler);
			entryHandler.on('all', wrappedHandler);
		}
		// otherwise this is a custom config entry handler
		else {
			entryHandler = this.#createEntryHandler(filesOrHandler);
			if (handler) {
				const wrappedHandler = wrapHandler(entryHandler, handler);
				entryHandler.on('all', wrappedHandler);
			}
		}

		return entryHandler;
	}

	requestRestart() {
		if (this.#deployInFlight) {
			this.#restartRequestedDuringDeploy = true;
			this.#logger.debug?.(`Restart suppressed (deploy in flight) for ${this.#appName}`);
			return;
		}
		this.#logger.debug?.(`Restart requested from ${this.#pluginName} scope for ${this.#appName}`);
		requestRestart();
	}

	/**
	 * Wait for all entry handlers' initial loads to complete.
	 * This includes waiting for any async operations in entry handler callbacks.
	 * Called by the component loader after handleApplication completes.
	 */
	async waitForInitialLoads(): Promise<void> {
		if (this.#pendingInitialLoads.size > 0) {
			await Promise.all(this.#pendingInitialLoads);
		}
	}

	waitForDeployCompletion(timeoutMs = 6 * 60 * 60 * 1000): Promise<void> {
		if (!this.#deployInFlight) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				deployLifecycle.off('deploy:end', handleDeployEnd);
				reject(new Error(`Timed out waiting for deployment of ${this.#appName} to complete`));
			}, timeoutMs);
			timer.unref?.();
			const handleDeployEnd = (componentName: string) => {
				if (componentName !== this.#appName || this.#deployInFlight) return;
				deployLifecycle.off('deploy:end', handleDeployEnd);
				clearTimeout(timer);
				resolve();
			};
			deployLifecycle.on('deploy:end', handleDeployEnd);
			if (!this.#deployInFlight) {
				deployLifecycle.off('deploy:end', handleDeployEnd);
				clearTimeout(timer);
				resolve();
			}
		});
	}

	disposeBearerValidators(): void {
		this.#bearerValidatorsDisposed = true;
		while (this.#bearerValidatorDisposers.length > 0) {
			this.#bearerValidatorDisposers.pop()!();
		}
	}

	/**
	 * Import a file into the scope's sandbox.
	 * @param filePath - The path of the file to import.
	 * @returns A promise that resolves with the imported module or value.
	 */
	async import(filePath: string): Promise<unknown> {
		return this.applicationScope ? this.applicationScope.import(filePath) : import(filePath);
	}
}
