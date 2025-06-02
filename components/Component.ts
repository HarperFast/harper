import { resolveBaseURLPath } from './resolveBaseURLPath';
import { deriveCommonPatternBase } from './deriveCommonPatternBase';
import { deriveGlobOptions, FastGlobOptions, FilesOption } from './deriveGlobOptions';
import { scan } from 'micromatch';

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
	readonly patternBases: string[];
	readonly directory: string;
	readonly name: string;
	readonly config: ComponentV2Config;
	readonly commonPatternBase: string;

	constructor(name: string, directory: string, config: ComponentV2Config) {
		this.name = name;
		this.directory = directory;
		this.config = config;

		this.baseURLPath = resolveBaseURLPath(this.name, this.config.urlPath);

		this.globOptions = deriveGlobOptions(this.config.files);
		this.globOptions.source = this.globOptions.source.map((pattern) => {
			if (pattern.includes('..') || pattern.startsWith('/')) {
				throw new ComponentV2InvalidPatternError(pattern);
			}

			if (pattern === '.' || pattern === './') {
				return '**/*';
			}

			return pattern;
		});

		this.patternBases = this.globOptions.source.map((pattern) => scan(pattern).base);
		this.commonPatternBase = deriveCommonPatternBase(this.patternBases);
	}
}
