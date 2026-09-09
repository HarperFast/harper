import type { Resources } from '../resources/Resources.ts';
import { type Server } from '../server/Server.ts';
import { forComponent } from '../utility/logging/harper_logger.ts';
import { scopedImport } from '../security/jsLoader.ts';
import * as env from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { RuntimeModuleTracker } from './RuntimeModuleTracker.ts';
import { deployLifecycle } from './deployLifecycle.ts';

export class MissingDefaultFilesOptionError extends Error {
	constructor() {
		super('No default files option exists. Ensure `files` is specified in config.yaml');
		this.name = 'MissingDefaultFilesOptionError';
	}
}

/**
 * This class is used to represent the application scope for the VM context used for loading modules within an application
 */
export class ApplicationScope {
	/** Component identity (application directory name) — what secret grants are matched against. */
	name: string;
	logger: any;
	resources: Resources;
	server: Server;
	mode?: 'native' | 'vm' | 'vm-current-context' | 'compartment'; // option to set this from the scope
	dependencyLoader?: 'native' | 'app' | 'auto'; // option to set this from the scope
	allowedPath?: string;
	runtimeRoot?: string;
	config: any;
	/**
	 * Private forks of the databases this application declared, keyed by the LOGICAL name its code
	 * uses (`data`). Present only for a branched application; `getHarperExports` reads it to build
	 * the scoped `databases` binding, and an unbranched scope leaves it undefined so that binding
	 * stays the process-wide singleton by identity.
	 */
	branches?: Map<string, { tables: any }>;
	moduleCache: any; // used by the loader to retain a cache of modules, type is an internal detail of the loader
	#runtimeModules: RuntimeModuleTracker;
	constructor(name: string, resources: Resources, server: Server, isInternal = false) {
		this.name = name;
		this.logger = forComponent(name, !isInternal);

		this.resources = resources;
		this.server = server;
		this.#runtimeModules = new RuntimeModuleTracker(() => this.runtimeRoot);
		if (deployLifecycle.isDeployInFlight(name)) this.#runtimeModules.beginDeploy();

		this.mode = env.get(CONFIG_PARAMS.APPLICATIONS_MODULELOADER) ?? 'vm-current-context';
		this.dependencyLoader = env.get(CONFIG_PARAMS.APPLICATIONS_DEPENDENCYLOADER);
		if (env.get(CONFIG_PARAMS.APPLICATIONS_ALLOWEDDIRECTORY) !== 'app') this.allowedPath = ''; // this is used to match paths by startsWith, so empty string matches everything
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

	recordLoadedModule(moduleUrl: string, source: string | Buffer): void {
		this.#runtimeModules.recordModule(moduleUrl, source);
	}

	recordModuleResolution(specifier: string, referrer: string, resolvedUrl: string): void {
		this.#runtimeModules.recordResolution(specifier, referrer, resolvedUrl);
	}

	markNativeRuntime(): void {
		this.#runtimeModules.markNativeRuntime();
	}

	beginDeploy(): void {
		this.#runtimeModules.beginDeploy();
	}

	finishDeploy(): Promise<boolean> {
		return this.#runtimeModules.finishDeploy();
	}
}
