import type { Resources } from '../resources/Resources.ts';
import { type Server } from '../server/Server.ts';
import { forComponent } from '../utility/logging/harper_logger.js';
import { scopedImport } from '../security/jsLoader.ts';
import * as env from '../utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';

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
	logger: any;
	resources: Resources;
	server: Server;
	mode?: 'none' | 'vm' | 'compartment'; // option to set this from the scope
	dependencyContainment?: boolean; // option to set this from the scope
	verifyPath?: string;
	config: any;
	constructor(name: string, resources: Resources, server: Server, isInternal = false, verifyPath?: string) {
		this.logger = forComponent(name, !isInternal);

		this.resources = resources;
		this.server = server;

		this.mode = env.get(CONFIG_PARAMS.APPLICATIONS_CONTAINMENT) ?? 'vm';
		this.dependencyContainment = Boolean(env.get(CONFIG_PARAMS.APPLICATIONS_DEPENDENCYCONTAINMENT));
		this.verifyPath = verifyPath;
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
