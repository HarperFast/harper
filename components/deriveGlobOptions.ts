interface FilesOptionObject {
	source: string | string[];
	// TODO: @Ethan-Arrowood - https://harperdb.atlassian.net/browse/CORE-2815
	only?: 'all' | 'files' | 'directories';
	ignore?: string | string[];
}

export type FilesOption = string | string[] | FilesOptionObject;

export type FastGlobOptions = {
	source: string[];
	ignore: string[];
	onlyFiles: boolean;
	onlyDirectories: boolean;
};

export function deriveGlobOptions(files: FilesOption): FastGlobOptions {
	const options: FastGlobOptions = {
		source: [],
		onlyFiles: false,
		onlyDirectories: false,
		ignore: [],
	};

	const addToArray = (target: string[], value?: string | string[]) => {
		if (typeof value === 'string') {
			target.push(value);
		} else if (Array.isArray(value)) {
			target.push(...value);
		}
	};

	if (typeof files === 'string' || Array.isArray(files)) {
		addToArray(options.source, files);
	} else {
		addToArray(options.source, files.source);
		addToArray(options.ignore, files.ignore);

		options.onlyFiles = files.only === 'files';
		options.onlyDirectories = files.only === 'directories';
	}

	return options;
}
