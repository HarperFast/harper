import { type Logger } from '../utility/logging/logger.ts';
import { loggerWithTag } from '../utility/logging/harper_logger.ts';
import { EventEmitter, once } from 'node:events';
import { databaseEventsEmitter, table } from '../resources/databases.ts';
import { server, type Server } from '../server/Server.ts';
import { EntryHandler, type EntryHandlerEventMap, type onEntryEventHandler } from './EntryHandler.ts';
import { OptionsWatcher, OptionsWatcherEventMap } from './OptionsWatcher.ts';
import { resources, type Resources } from '../resources/Resources.ts';
import { Models, models as modelsSingleton } from '../resources/models/Models.ts';
import type { FileAndURLPathConfig } from './Component.ts';
import { FilesOption } from './deriveGlobOptions.ts';
import { requestRestart } from './requestRestart.ts';
import { ApplicationScope } from './ApplicationScope.ts';
import { deployLifecycle } from './deployLifecycle.ts';

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
	// Fired after deploy I/O completes (success or failure). The scope's
	// EntryHandlers have been recreated by this point; subsequent `add`/`change`
	// events reflect the post-deploy tree.
	'deploy:end': [componentName: string];
	[record: string]: [...args: unknown[]];
};

/**
 * This class is what is passed to the `handleApplication` function of an extension.
 *
 * It is imperative that the instance is "ready" before it's passed to the `handleApplication` function
 * so that the developer can immediately start using `scope.options`, etc.
 *
 */
export class Scope extends EventEmitter<ScopeEventsMap> {
	#configFilePath: string;
	#directory: string;
	#appName: string;
	#pluginName: string;
	#origin: string;
	#entryHandler?: EntryHandler;
	#entryHandlers: EntryHandler[];
	#logger: Logger;
	#pendingInitialLoads: Set<Promise<void>>;
	#deployStartHandler: (name: string) => void;
	#deployEndHandler: (name: string) => void;
	// While a deploy of this component is in flight, EntryHandler events do not
	// drive requestRestart() — the deploy itself produces hundreds of file
	// changes that would otherwise pile up. A single coalesced restart is
	// triggered by the post-deploy re-scan instead.
	#deployInFlight: boolean = false;
	applicationScope?: ApplicationScope;

	options: OptionsWatcher;
	resources?: Resources;
	server?: Server;
	ready: Promise<any[]>;
	databaseEvents: typeof databaseEventsEmitter;
	models: Models;

	constructor(
		appName: string,
		pluginName: string,
		directory: string,
		configFilePath: string,
		applicationScope: ApplicationScope,
		origin: string = appName
	) {
		super();

		this.#appName = appName;
		this.#pluginName = pluginName;
		this.#origin = typeof origin === 'string' ? origin : appName;
		this.#directory = directory;
		this.#configFilePath = configFilePath;
		this.#logger = loggerWithTag(this.#appName);

		this.databaseEvents = databaseEventsEmitter;
		this.applicationScope = applicationScope;
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
							const scopeConfig = (scopeRef.options?.getAll() as any) ?? {};
							return method.call(target, listener, {
								name: pluginName,
								urlPath: scopeConfig.urlPath || undefined,
								host: scopeConfig.host || undefined,
								...options,
							});
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
		this.options = new OptionsWatcher(pluginName, configFilePath, this.#logger)
			.on('error', this.#handleError.bind(this))
			.on('change', this.#optionsWatcherChangeListener.bind(this)())
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

	get appName(): string {
		return this.#appName;
	}

	get pluginName(): string {
		return this.#pluginName;
	}

	get directory(): string {
		return this.#directory;
	}

	get configFilePath(): string {
		return this.#configFilePath;
	}

	ensureTable<TableResourceType = unknown>(options: any): TableResourceType {
		options.origin = this.#origin;
		return table<TableResourceType>(options);
	}

	#handleOptionsWatcherReady(): void {
		// This previously created the default entry handler immediately, but now we wait for the user to call `handleEntry`
		// The issue was that since the component loader was awaiting `scope.ready()` and then calling `pluginModule.handleApplication(scope)`,
		// the default entry handler could start receiving events before the plugin provided its own handler.
		// We could make the user call `await scope.ready()` in their `handleApplication` function, but that could lead to the same issue and it'd
		// be harder for the user to understand why.

		this.emit('ready');
	}

	#handleError(error: unknown): void {
		this.emit('error', error);
	}

	async close(): Promise<this> {
		deployLifecycle.off('deploy:start', this.#deployStartHandler);
		deployLifecycle.off('deploy:end', this.#deployEndHandler);

		await Promise.allSettled([...this.#entryHandlers.map((h) => h.close()), this.options.close()]);

		this.emit('close');
		this.removeAllListeners();

		return this;
	}

	#onDeployStart(componentName: string): void {
		this.#deployInFlight = true;
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

		// Resume each EntryHandler BEFORE notifying plugins. Otherwise a plugin
		// throwing in its deploy:end handler would abort this function and
		// leave the watchers permanently paused (surfaced by Gemini review).
		// The fresh chokidar watcher does an initial scan and emits add events
		// for the post-deploy tree; the existing per-event listener calls
		// scope.requestRestart() for each, and the restart debounce in
		// componentLoader collapses them into a single restart cycle. Plugin
		// handlers stay attached across the pause.
		for (const entryHandler of this.#entryHandlers) {
			void entryHandler.resume();
		}

		this.#safeEmit('deploy:end', componentName);
	}

	// Swallow and log listener exceptions so one buggy plugin can't stop us
	// from running the rest of the deploy-lifecycle bookkeeping. EventEmitter
	// by default rethrows from synchronous listeners.
	#safeEmit(event: 'deploy:start' | 'deploy:end', componentName: string): void {
		try {
			this.emit(event, componentName);
		} catch (error) {
			this.#logger.error?.(`Listener for ${event} threw for ${this.#appName}:`, error);
		}
	}

	#createEntryHandler(config: FilesOption | FileAndURLPathConfig): EntryHandler {
		const entryHandler = new EntryHandler(this.#pluginName, this.#directory, config, this.#logger)
			.on('error', this.#handleError.bind(this))
			.on('add', this.#defaultEntryHandlerListener('add'))
			.on('change', this.#defaultEntryHandlerListener('change'))
			.on('unlink', this.#defaultEntryHandlerListener('unlink'))
			.on('addDir', this.#defaultEntryHandlerListener('addDir'))
			.on('unlinkDir', this.#defaultEntryHandlerListener('unlinkDir'));

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

				// If not entry handler exists then likely the config did not have `files` initially
				// Now, it does, so create a default entry handler.
				if (!scope.#entryHandler) {
					scope.#entryHandler = scope.#createEntryHandler(config as FileAndURLPathConfig);
					return;
				}

				// Otherwise, if an entry handler exists, update it with the new config
				scope.#entryHandler.update(config as FileAndURLPathConfig);

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
		let entryHandler: EntryHandler;

		// Helper to wrap async handlers for tracking
		const wrapHandler = (
			targetEntryHandler: EntryHandler,
			entryEventHandler: onEntryEventHandler
		): onEntryEventHandler => {
			const pendingOperations = new Set<Promise<void>>();

			const wrapped: onEntryEventHandler = (entry) => {
				const result = entryEventHandler(entry);
				if (result instanceof Promise) {
					const tracked = result
						.catch((error) => {
							this.#logger.error?.('Error in async entry handler:', error);
							this.#handleError(error);
							throw error;
						})
						.finally(() => pendingOperations.delete(tracked));
					pendingOperations.add(tracked);
				}
			};

			// When the entry handler's initial scan completes, wait for all pending async operations
			const initialLoadPromise = once(targetEntryHandler, 'ready').then(async () => {
				if (pendingOperations.size > 0) {
					await Promise.all(pendingOperations);
				}
				targetEntryHandler.emit('initialLoadComplete');
			});

			// Track this promise so the component loader can await it
			this.#pendingInitialLoads.add(initialLoadPromise);
			initialLoadPromise.finally(() => this.#pendingInitialLoads.delete(initialLoadPromise));

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
			// Suppressed: a deploy is rewriting this component's files. The
			// post-deploy re-scan in #onDeployEnd will trigger the coalesced
			// restart instead.
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

	/**
	 * Import a file into the scope's sandbox.
	 * @param filePath - The path of the file to import.
	 * @returns A promise that resolves with the imported module or value.
	 */
	async import(filePath: string): Promise<unknown> {
		return this.applicationScope ? this.applicationScope.import(filePath) : import(filePath);
	}
}
