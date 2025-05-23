import { isMainThread } from 'node:worker_threads';
import fg from 'fast-glob';
import { Resources } from '../resources/Resources.ts';
import harperLogger from '../utility/logging/harper_logger.js';
import { derivePatternRoots } from './derivePatternRoots.ts';
import { resolveBaseURLPath } from './resolveBaseURLPath.ts';
import { deriveGlobOptions, FastGlobOptions, FilesOption } from './deriveGlobOptions.ts';
import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';

interface ComponentConfig {
	files: string | string[] | FilesOption;
	/** @deprecated */ path?: string;
	urlPath?: string;
	/** @deprecated */ root?: string;
	[key: string]: any;
}

interface ComponentModule {
	setupDirectory?: (urlPath: string, absolutePath: string, resources: Resources) => Promise<undefined | boolean>;
	handleDirectory?: (urlPath: string, absolutePath: string, resources: Resources) => Promise<undefined | boolean>;
	setupFile?: (contents: Buffer, urlPath: string, absolutePath: string, resources: Resources) => Promise<void>;
	handleFile?: (contents: Buffer, urlPath: string, absolutePath: string, resources: Resources) => Promise<void>;
}

interface ComponentDetails {
	config: ComponentConfig;
	name: string;
	directory: string;
	module: ComponentModule;
	resources: Resources;
}

export class Component {
	readonly config: Readonly<ComponentConfig>;
	readonly name: string;
	readonly directory: string;
	readonly module: Readonly<ComponentModule>;
	readonly resources: Resources;
	readonly globOptions: FastGlobOptions;
	readonly patternRoots: string[];
	readonly baseURLPath: string;

	constructor(options: ComponentDetails) {
		// TO DO: Unfortunately `readonly` is a TS only thing and doesn't actually enforce that these properties can't be modified.
		// Freeze these things so they can't be changed. likely do this at the end of the constructor
		this.config = options.config;
		this.name = options.name;
		this.directory = options.directory;
		this.module = options.module;
		this.resources = options.resources;

		// Config option basic validation
		if (
			!isNonEmptyString(this.config.files) &&
			!isArrayOfNonEmptyStrings(this.config.files) &&
			!isObject(this.config.files)
		) {
			throw new InvalidFilesOptionError(this);
		}

		// Validating the `files` object
		if (typeof this.config.files === 'object' && !Array.isArray(this.config.files)) {
			if (
				this.config.files.source === undefined ||
				(!isArrayOfNonEmptyStrings(this.config.files.source) && !isNonEmptyString(this.config.files.source))
			) {
				throw new InvalidFilesSourceOptionError(this);
			}

			if (
				this.config.files.only !== undefined &&
				(typeof this.config.files.only !== 'string' ||
					!['all', 'files', 'directories'].includes(this.config.files.only))
			) {
				throw new InvalidFilesOnlyOptionError(this);
			}

			if (
				this.config.files.ignore !== undefined &&
				!isArrayOfNonEmptyStrings(this.config.files.ignore) &&
				!isNonEmptyString(this.config.files.ignore)
			) {
				throw new InvalidFileIgnoreOptionError(this);
			}
		}

		// Validate the deprecated options too
		if (this.config.root !== undefined && !isNonEmptyString(this.config.root)) {
			throw new InvalidRootOptionError(this);
		}

		if (this.config.path !== undefined && !isNonEmptyString(this.config.path)) {
			throw new InvalidPathOptionError(this);
		}

		// Handle deprecated `path` option
		if (this.config.path) {
			harperLogger.warn(`Resource extension 'path' option is deprecated. Please replace with 'urlPath'.`);
			this.config.urlPath = this.config.path;
		}

		// Validate the `urlPath`
		if (
			this.config.urlPath !== undefined &&
			(!isNonEmptyString(this.config.urlPath) ||
				(typeof this.config.urlPath === 'string' && this.config.urlPath.includes('..')))
		) {
			throw new InvalidURLPathOptionError(this);
		}

		this.globOptions = deriveGlobOptions(this.config.files);
		// Validate and transform glob patterns
		this.globOptions.source = this.globOptions.source.map((pattern) => {
			if (pattern.includes('..')) {
				throw new InvalidGlobPattern(this, pattern);
			}

			if (pattern.startsWith('/')) {
				harperLogger.warn(
					`Leading '/' in 'files' glob pattern is deprecated. For backwards compatibility purposes, it is currently transformed to the relative path of the component, but in the future will result in an error. Please replace with a relative path such as './' or removing the leading path separator all together ('./static/*' -> 'static/*').`
				);

				pattern = pattern === '/' ? './' : pattern.slice(1);
			}

			return pattern;
		});
		this.patternRoots = derivePatternRoots(this.globOptions.source);
		this.baseURLPath = resolveBaseURLPath(this.name, this.config.urlPath);
	}
}

export class ComponentProcessingError extends Error {
	constructor(message: string, component: ComponentDetails) {
		super(`Component ${component.name} (from ${basename(component.directory)}) ${message}`);
	}
}

export class InvalidFilesOptionError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(`'files' option must be a non-empty string, an array of non-empty strings, or an object.`, component);
	}
}

export class InvalidFilesSourceOptionError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(`'files' object must have a non-empty 'source' property.`, component);
	}
}

export class InvalidFilesOnlyOptionError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(`'files.only' option must be one of 'all', 'files', or 'directories'.`, component);
	}
}

export class InvalidFileIgnoreOptionError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(`'files.ignore' option must be a non-empty string or an array of non-empty strings.`, component);
	}
}

export class InvalidGlobPattern extends ComponentProcessingError {
	constructor(component: ComponentDetails, pattern: string) {
		super(`'files' glob pattern must not contain '..'. Received: '${pattern}'`, component);
	}
}

export class InvalidRootOptionError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(
			`deprecated 'root' option must be a non-empty string. Consider removing and updating 'files' glob pattern instead.`,
			component
		);
	}
}

export class InvalidRootOptionUseError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(
			`the 'root' option is deprecated and only supported if 'files' is a singular, non-empty string. Please remove the 'root' option and modify the 'files' glob pattern instead.`,
			component
		);
	}
}

export class InvalidPathOptionError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(`deprecated 'path' option must be a non-empty string. Consider replacing with 'urlPath'.`, component);
	}
}

export class InvalidURLPathOptionError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(`'urlPath' option must be a non-empty string that must not contain '..'.`, component);
	}
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '';
}

function isArrayOfNonEmptyStrings(value: unknown): value is string[] {
	return Array.isArray(value) && value.length !== 0 && value.every((item) => isNonEmptyString(item));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function handleRoots(component: Component) {
	if (component.config.root) {
		harperLogger.warn(
			`Resource extension 'root' option is deprecated. Due to backwards compatibility reasons it does not act as assumed. The glob pattern will always be evaluated from the component directory root. The option is only used for the initial root directory handling. Please remove and modify the 'files' glob pattern instead.`
		);
	}

	// For backwards compatibility, we need to evaluate the root path via the existing logic. This is only valid if `root` is defined, and `files` is a strings that doesn't contain `**/*`,
	// And if that existing logic does not produce a reasonable root path to evaluate, we can consider the configure "new" and evaluate it based on a new process

	let rootPaths: string[] = [];

	if (component.config.root && typeof component.config.files !== 'string') {
		throw new InvalidRootOptionUseError(component);
	}

	// This starts old root handling
	let rootPath = component.config.root;

	if (rootPath) {
		// trim any leading slashes
		if (rootPath.startsWith('/')) {
			rootPath = rootPath.slice(1);
		}
		// add a trailing slash if it doesn't exist
		if (!rootPath.endsWith('/')) {
			rootPath += '/';
		}
	}

	const pattern = component.config.files;

	// This is still old root handling logic - operate only a singular pattern
	if (typeof pattern === 'string' && !pattern.includes('**/*')) {
		if (pattern.indexOf('/*') > -1) {
			rootPath = pattern.slice(0, pattern.indexOf('/*') + 1);
		} else if (pattern.indexOf('/') > -1) {
			rootPath = pattern.slice(0, pattern.lastIndexOf('/') + 1);
		}
	}

	if (rootPath) rootPaths.push(rootPath);

	// If old handling did not result in a root path, now use the patternRoots derived from the processed glob patterns
	if (rootPaths.length === 0) {
		// Return early if we are only processing files
		if (isObject(component.config.files) && component.config.files.only === 'files') {
			return false;
		}

		rootPaths = component.patternRoots;
	}

	let hasFunctionality: boolean | undefined = false;

	for (const rootPath of rootPaths) {
		if (!rootPath) continue;
		const rootPathAbsolute = join(component.directory, rootPath);

		if (isMainThread && component.module.setupDirectory) {
			hasFunctionality = await component.module.setupDirectory(
				component.baseURLPath,
				rootPathAbsolute,
				component.resources
			);
		}
		if (component.resources.isWorker && component.module.handleDirectory) {
			hasFunctionality = await component.module.handleDirectory(
				component.baseURLPath,
				rootPathAbsolute,
				component.resources
			);
		}
	}

	return hasFunctionality;
}

/**
 * Process a Resource Extension component by evaluating the files glob pattern
 * and then calling the appropriate setup/handle functions.
 */
export async function processResourceExtensionComponent(component: Component) {
	let hasFunctionality: boolean | undefined = false;

	hasFunctionality = await handleRoots(component);

	// Return early if roots were functional
	if (hasFunctionality) return hasFunctionality;

	const matches = await fg(component.globOptions.source, {
		cwd: component.directory,
		objectMode: true,
		onlyFiles: component.globOptions.onlyFiles,
		onlyDirectories: component.globOptions.onlyDirectories,
		ignore: component.globOptions.ignore,
	});

	for (const entry of matches) {
		let entryPathPart = entry.path;

		if (entryPathPart !== '/') {
			for (const root of component.patternRoots) {
				if (entry.path.startsWith(root)) {
					entryPathPart = entry.path.slice(root.length);
					break;
				}
			}
		}

		const urlPath = join(component.baseURLPath, entryPathPart);
		const absolutePath = join(component.directory, entry.path);

		if (entry.dirent.isDirectory()) {
			if (isMainThread && component.module.setupDirectory) {
				await component.module.setupDirectory(urlPath, absolutePath, component.resources);
				hasFunctionality = true;
			}
			if (component.resources.isWorker && component.module.handleDirectory) {
				await component.module.handleDirectory(urlPath, absolutePath, component.resources);
				hasFunctionality = true;
			}
		} else if (entry.dirent.isFile()) {
			const contents = await readFile(absolutePath);
			if (isMainThread && component.module.setupFile) {
				await component.module.setupFile(contents, urlPath, absolutePath, component.resources);
				hasFunctionality = true;
			} else if (component.resources.isWorker && component.module.handleFile) {
				await component.module.handleFile(contents, urlPath, absolutePath, component.resources);
				hasFunctionality = true;
			}
		} else {
			harperLogger.error(
				`Entry received from glob pattern match for component ${component.name} is neither a file nor a directory:`,
				entry
			);
		}
	}

	return hasFunctionality;
}
