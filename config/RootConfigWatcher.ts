import chokidar, { FSWatcher } from 'chokidar';
import { readFile } from 'node:fs/promises';
import { getConfigFilePath } from './configUtils.js';
import { EventEmitter, once } from 'node:events';
import { parse } from 'yaml';

export class RootConfigWatcher extends EventEmitter {
	#configFilePath: string;
	#watcher: FSWatcher;
	#config: any;
	ready: Promise<any[]>;

	constructor() {
		super();
		this.#configFilePath = getConfigFilePath();
		this.ready = once(this, 'ready');
		this.#watcher = chokidar
			.watch(this.#configFilePath, { persistent: false })
			.on('add', this.handleChange.bind(this))
			.on('change', this.handleChange.bind(this))
			.on('error', this.handleError.bind(this));
	}

	handleError(error: unknown) {
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
			.catch((error) => {
				// if yaml parse error ignore?
			});
	}

	close() {
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
