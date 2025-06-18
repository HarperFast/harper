import { resolveBaseURLPath } from './resolveBaseURLPath';
import { deriveCommonPatternBase } from './deriveCommonPatternBase';
import { deriveGlobOptions, FastGlobOptions, FilesOption } from './deriveGlobOptions';
import { scan } from 'micromatch';

interface ComponentConfig {
	files: FilesOption;
	urlPath?: string;
	[key: string]: unknown;
}

export type FileAndURLPathConfig = Pick<ComponentConfig, 'files' | 'urlPath'>;

export class ComponentInvalidPatternError extends Error {
	constructor(pattern: string) {
		super(`Config 'files' option glob pattern must not contain '..' or start with '/'. Received: '${pattern}'`);
		this.name = 'ComponentInvalidPatternError';
	}
}

export class Component {
	readonly globOptions: FastGlobOptions;
	readonly baseURLPath: string;
	readonly patternBases: string[];
	readonly directory: string;
	readonly name: string;
	readonly config: ComponentConfig;
	readonly commonPatternBase: string;

	constructor(name: string, directory: string, config: ComponentConfig) {
		this.name = name;
		this.directory = directory;
		this.config = config;

		this.baseURLPath = resolveBaseURLPath(this.name, this.config.urlPath);

		this.globOptions = deriveGlobOptions(this.config.files);
		this.globOptions.source = this.globOptions.source.map((pattern) => {
			if (pattern.includes('..') || pattern.startsWith('/')) {
				throw new ComponentInvalidPatternError(pattern);
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
