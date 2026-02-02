import { EventEmitter, once } from 'node:events';
import { type Server } from '../server/Server.ts';
import { EntryHandler, type EntryHandlerEventMap, type onEntryEventHandler } from './EntryHandler.ts';
import { OptionsWatcher, OptionsWatcherEventMap } from './OptionsWatcher.ts';
import { loggerWithTag } from '../utility/logging/harper_logger.js';
import type { Resources } from '../resources/Resources.ts';
import type { FileAndURLPathConfig } from './Component.ts';
import { FilesOption } from './deriveGlobOptions.ts';
import { requestRestart } from './requestRestart.ts';
import { scopedImport } from '../security/jsLoader.ts';

export class MissingDefaultFilesOptionError extends Error {
	constructor() {
		super('No default files option exists. Ensure `files` is specified in config.yaml');
		this.name = 'MissingDefaultFilesOptionError';
	}
}

export interface ApplicationContainment {
	mode?: 'none' | 'vm' | 'compartment'; // option to set this from the scope
	dependencyContainment?: boolean; // option to set this from the scope
	verifyPath?: string;
}

/**
 * This class is what is passed to the `handleApplication` function of an extension.
 *
 * It is imperative that the instance is "ready" before its passed to the `handleApplication` function
 * so that the developer can immediately start using `scope.options`, etc.
 *
 */
export class Scope extends EventEmitter {
	#configFilePath: string;
	#directory: string;
	#name: string;
	#entryHandler?: EntryHandler;
	#entryHandlers: EntryHandler[];
	#logger: any;
	#pendingInitialLoads: Set<Promise<void>>;

	options: OptionsWatcher;
	resources: Resources;
	server: Server;
	ready: Promise<any[]>;
	declare applicationContainment?: ApplicationContainment;
	constructor(name: string, directory: string, configFilePath: string, resources: Resources, server: Server) {
		super();

		this.#name = name;
		this.#directory = directory;
		this.#configFilePath = configFilePath;
		this.#logger = loggerWithTag(this.#name);

		this.resources = resources;
		this.server = server;

		this.#entryHandlers = [];
		this.#pendingInitialLoads = new Set();

		this.ready = once(this, 'ready');

		// Create the options instance for the scope immediately
		this.options = new OptionsWatcher(name, configFilePath, this.#logger)
			.on('error', this.#handleError.bind(this))
			.on('change', this.#optionsWatcherChangeListener.bind(this)())
			.on('ready', this.#handleOptionsWatcherReady.bind(this));
	}

	get logger(): any {
		return this.#logger;
	}

	get name(): string {
		return this.#name;
	}

	get directory(): string {
		return this.#directory;
	}

	get configFilePath(): string {
		return this.#configFilePath;
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

	close() {
		for (const entryHandler of this.#entryHandlers) {
			entryHandler.close();
		}

		this.options.close();

		this.emit('close');

		this.removeAllListeners();

		return this;
	}

	#createEntryHandler(config: FilesOption | FileAndURLPathConfig): EntryHandler {
		const entryHandler = new EntryHandler(this.#name, this.#directory, config, this.#logger)
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

			scope.#logger.debug(`Options changed: ${key.join('.')}, requesting restart`);
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
		this.#logger.debug(`Restart requested from ${this.name} scope for ${this.directory}`);
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
	 * The compartment that is used for this scope and any imports that it makes
	 */
	compartment?: Promise<any>;
	/**
	 * Import a file into the scope's sandbox.
	 * @param filePath - The path of the file to import.
	 * @returns A promise that resolves with the imported module or value.
	 */
	async import(filePath: string): Promise<unknown> {
		return scopedImport(filePath, this);
	}
}
