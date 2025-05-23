import { EventEmitter, once } from 'events';
import yaml from 'yaml';
import chokidar, { type FSWatcher } from 'chokidar';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'util';
import harperLogger from '../utility/logging/harper_logger.js';

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
	#watcher: FSWatcher;
	#scopedConfig?: ConfigValue;
	#rootConfig?: Config;
	#name: string;
	#logger: any;

	constructor(name: string, filePath: string, logger?: any) {
		super();
		this.#name = name;
		this.#filePath = filePath;
		this.#logger = logger || harperLogger.loggerWithTag(name);

		this.#watcher = chokidar
			.watch(filePath, { persistent: false })
			.on('add', this.handleChange.bind(this))
			.on('change', this.handleChange.bind(this))
			.on('error', this.handleError.bind(this))
			.on('unlink', this.handleUnlink.bind(this))
			.on('ready', this.handleChange.bind(this));
	}

	private handleChange() {
		readFile(this.#filePath, 'utf-8')
			.then((contents) => {
				this.#rootConfig = yaml.parse(contents);
				// If the extension is in the config file
				if (this.#rootConfig && this.#name in this.#rootConfig) {
					// If a config object does not exist
					if (!this.#scopedConfig) {
						// set it
						this.#scopedConfig = this.#rootConfig[this.#name];
						// and emit a ready event
						this.emit('ready', this.#scopedConfig);
					} else {
						// Otherwise, merge the new config with the old config
						this.merge(this.#rootConfig[this.#name], this.#scopedConfig);
					}
				} else {
					// Otherwise, if the extension is not in the config file
					if (this.#scopedConfig) {
						// and a config exists, remove it
						this.#scopedConfig = undefined;
						this.emit('remove');
					}
					// Otherwise do nothing - the user may add the config back in later
				}
			})
			.catch((error) => {
				if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
					if (this.#scopedConfig) {
						this.#scopedConfig = undefined;
						this.emit('remove');
					} else {
						this.emit('ready');
					}
					return;
				}
				this.emit('error', error);
			});
	}

	private handleError(error: unknown) {
		this.emit('error', new OptionsWatcherConfigFileError(this.#filePath, error));
	}

	private handleUnlink(path: string) {
		this.#logger.warn(`Configuration file ${path} was deleted. Recreate it to restore the options watcher.`);
		this.#scopedConfig = undefined;
		this.emit('remove');
	}

	/**
	 * This merge algorithm is best thought off as a diff and overwrite.
	 * The new config object will completely overwrite the old config object,
	 * but we need to recursively iterate over the new entries and emit the
	 * necessary change events.
	 *
	 * All events are considered to be a `change`.
	 */
	private merge(newConfigValue: ConfigValue, currentConfigValue: ConfigValue, prevKeys: string[] = []) {
		// First, ensure current and new config values are Config objects (not null, undefined, or a primitive)
		if (!this.isConfig(currentConfigValue) || !this.isConfig(newConfigValue)) {
			// If either is not a config, then just set as there is no need to diff/merge
			this.setValue(prevKeys, newConfigValue);
			return;
		}

		// Check for any missing keys (new config has removed keys from current config)
		for (const key of Object.keys(currentConfigValue)) {
			if (!(key in newConfigValue)) {
				this.setValue(prevKeys.concat(key), undefined);
			}
		}

		// Then, iterate of the keys in the new config and check for any changes to the current config
		for (const [key, newValue] of Object.entries(newConfigValue)) {
			const keys = prevKeys.concat(key);
			const currentValue = this.getValue(keys);

			// If the new value is not the same type as the current value, then no equivalency check is necessary
			// Just set the value and continue
			if (
				typeof newValue !== typeof currentValue ||
				// one exception to the above rule is if the `currentValue` is being changed from an array to an object or vice versa
				// Check for this and shortcut as it can be treated as a type change
				(Array.isArray(newValue) && !Array.isArray(currentValue)) ||
				(!Array.isArray(newValue) && Array.isArray(currentValue))
			) {
				this.setValue(keys, newValue);
				continue;
			}

			// If the new value is an object (non null nor an array), now merge it with the current value
			if (!Array.isArray(newValue) && typeof newValue === 'object' && newValue !== null) {
				if (this.isConfig(currentValue)) {
					// Now we're sure currentValue is a Config
					this.merge(newValue, currentValue, keys);
				} else {
					// If currentValue is not a Config, just set newValue
					this.setValue(keys, newValue);
				}
				continue;
			}

			if (!isDeepStrictEqual(newValue, currentValue)) {
				this.setValue(keys, newValue);
			}
		}
	}

	private isConfig(value: ConfigValue): value is Config {
		return typeof value === 'object' && value !== null && value !== undefined && !Array.isArray(value);
	}

	private getValue(keys: string[]): undefined | ConfigValue {
		let value: ConfigValue = this.#scopedConfig;

		for (const key of keys) {
			if (value === null || value === undefined || typeof value !== 'object' || !(key in value)) return undefined;

			value = value[key];
		}

		return structuredClone(value);
	}

	private setValue(keys: string[], value: ConfigValue) {
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

		this.emit('change', keys, value, this.#scopedConfig);
	}

	/**
	 * Closes the underlying file watcher, emits the `close` event, and removes any listeners on the OptionsWatcher instance
	 */
	close() {
		this.#watcher.close();

		this.emit('close');

		this.removeAllListeners();

		return this;
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
	get(key: string): ConfigValue | undefined {
		return this.#scopedConfig ? this.getValue(key.split('.')) : undefined;
	}

	/**
	 * Get the entire configuration object.
	 *
	 * @returns A deep clone of the entire configuration object.
	 */
	getAll(): ConfigValue | undefined {
		return structuredClone(this.#scopedConfig);
	}

	/**
	 * Get the entire root configuration object from the config file.
	 */
	getRoot(): Config | undefined {
		return this.#rootConfig;
	}

	/**
	 * A shortcut to the `ready` event.
	 *
	 * Equivalent to awaiting for the `ready` event to be emitted i.e. `await once(optionsWatcher, 'ready')`
	 *
	 * @returns A promise that resolves when the watcher is ready.
	 */
	ready() {
		return once(this, 'ready');
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
	// 	this.setValue(key.split('.'), structuredClone(value));
	// }
}
