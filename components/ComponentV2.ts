import { resolveBaseURLPath } from './resolveBaseURLPath';
import { derivePatternRoots } from './derivePatternRoots';
import { deriveGlobOptions, FastGlobOptions, FilesOption } from './deriveGlobOptions';

interface ComponentV2Config {
	files: FilesOption;
	urlPath?: string;
	[key: string]: unknown;
}

export type FileAndURLPathConfig = Pick<ComponentV2Config, 'files' | 'urlPath'>;

export class ComponentV2InvalidPatternError extends Error {
	constructor(pattern: string) {
		super(`Config 'files' option glob pattern must not contain '..' or start with '/'. Received: '${pattern}'`);
		this.name = 'ComponentV2InvalidPatternError';
	}
}

export class ComponentV2 {
	readonly globOptions: FastGlobOptions;
	readonly baseURLPath: string;
	readonly patternRoots: string[];
	readonly directory: string;
	readonly name: string;
	readonly config: ComponentV2Config;
	constructor(name: string, directory: string, config: ComponentV2Config) {
		this.baseURLPath = resolveBaseURLPath(name, config.urlPath);
		this.config = config;
		this.directory = directory;
		this.name = name;
		this.globOptions = deriveGlobOptions(config.files);
		for (const pattern of this.globOptions.source) {
			if (pattern.includes('..') || pattern.startsWith('/')) {
				throw new ComponentV2InvalidPatternError(pattern);
			}
		}
		this.patternRoots = derivePatternRoots(this.globOptions.source);
	}
}
