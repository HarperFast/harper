import { EventEmitter, once } from 'node:events';
import { type Server } from '../server/Server.ts';
import { EntryHandler, type EntryHandlerEventMap, type onEntryEventHandler } from './EntryHandler.ts';
import { OptionsWatcher, OptionsWatcherEventMap } from './OptionsWatcher.ts';
import harperLogger from '../utility/logging/harper_logger.js';
import type { Resources } from '../resources/Resources.ts';
import type { FileAndURLPathConfig } from './ComponentV2.ts';
import { FilesOption } from './deriveGlobOptions.ts';
import { requestRestart } from './requestRestart.ts';

export class MissingDefaultEntryHandlerError extends Error {
	constructor() {
		super('No default entry handler exists. Ensure `files` is specified in config.yaml');
		this.name = 'MissingDefaultEntryHandlerError';
	}
}

/**
 * This class is what is passed to the `handleComponent` function of an extension.
 *
 * It is imperative that the instance is "ready" before its passed to the `handleComponent` function
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

	options: OptionsWatcher;
	resources: Resources;
	server: Server;

	constructor(name: string, directory: string, configFilePath: string, resources: Resources, server: Server) {
		super();

		this.#name = name;
		this.#directory = directory;
		this.#configFilePath = configFilePath;
		this.#logger = harperLogger.forComponent(this.#name);

		this.resources = resources;
		this.server = server;

		this.#entryHandlers = [];

		// Create the options instance for the scope immediately
		this.options = new OptionsWatcher(name, configFilePath, this.#logger)
			.on('error', this.handleError.bind(this))
			.on('change', this.optionsWatcherChangeListener.bind(this)())
			.on('ready', this.handleOptionsWatcherReady.bind(this));
	}

	private handleOptionsWatcherReady(): void {
		// After options are ready, check if the config contains `files`; create an EntryHandler if it does
		// This will be the default EntryHandler for the scope
		const config = this.options.getAll();
		if (config && typeof config === 'object' && config !== null && !Array.isArray(config) && 'files' in config) {
			this.#entryHandler = this.createEntryHandler(config as FileAndURLPathConfig);
		}

		this.emit('ready');
	}

	private handleError(error: unknown): void {
		this.emit('error', error);
	}

	ready() {
		return once(this, 'ready');
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

	private createEntryHandler(config: FilesOption | FileAndURLPathConfig): EntryHandler {
		const entryHandler = new EntryHandler(this.#name, this.#directory, config, this.#logger)
			.on('error', this.handleError.bind(this))
			.on('add', this.defaultEntryHandlerListener('add'))
			.on('change', this.defaultEntryHandlerListener('change'))
			.on('unlink', this.defaultEntryHandlerListener('unlink'))
			.on('addDir', this.defaultEntryHandlerListener('addDir'))
			.on('unlinkDir', this.defaultEntryHandlerListener('unlinkDir'));

		this.#entryHandlers.push(entryHandler);

		return entryHandler;
	}

	private defaultEntryHandlerListener(event: keyof EntryHandlerEventMap) {
		const scope = this;
		return function (this: EntryHandler) {
			if (this.listenerCount('all') > 0 || this.listenerCount(event) > 1) {
				return;
			}

			scope.requestRestart();
		};
	}

	private optionsWatcherChangeListener() {
		const scope = this;
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		return function handleOptionsWatcherChange(
			this: OptionsWatcher,
			...[key, _, config]: OptionsWatcherEventMap['change']
		) {
			if (key[0] === 'files' || key[0] === 'urlPath') {
				// TODO: validate options

				// If not entry handler exists then likely the config did not have `files` initially
				// Now, it does, so create a default entry handler.
				if (!scope.#entryHandler) {
					scope.#entryHandler = scope.createEntryHandler(config as FileAndURLPathConfig);
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

			scope.requestRestart();
		};
	}

	handleEntry(files: FilesOption | FileAndURLPathConfig, handler: onEntryEventHandler): EntryHandler;
	handleEntry(handler: onEntryEventHandler): EntryHandler;
	handleEntry(): EntryHandler;
	handleEntry(
		filesOrHandler?: FilesOption | FileAndURLPathConfig | onEntryEventHandler,
		handler?: onEntryEventHandler
	): EntryHandler | undefined {
		// No arguments, return default handler
		if (filesOrHandler === undefined) {
			if (!this.#entryHandler) {
				this.emit('error', new MissingDefaultEntryHandlerError());
				return;
			}
			return this.#entryHandler;
		}
		// Just a handler, add it to 'all' event (and return reference to handler)
		if (typeof filesOrHandler === 'function') {
			// If its just a function, then we have to check if the default entry handler exists
			if (!this.#entryHandler) {
				this.emit('error', new MissingDefaultEntryHandlerError());
				return;
			}
			// Ensure we return the entry handler
			return this.#entryHandler.on('all', filesOrHandler);
		}

		// otherwise this is a custom config entry handler
		const entryHandler = this.createEntryHandler(filesOrHandler);
		return handler ? entryHandler.on('all', handler) : entryHandler;
	}

	requestRestart() {
		this.#logger.debug('Restart requested!');
		requestRestart();
	}
}
