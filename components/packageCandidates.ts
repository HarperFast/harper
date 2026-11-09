import { dirname, join, sep } from 'node:path';

/**
 * Where the loader looks, in order, for the package a component's config entry `key` names: `node_modules/<key>`
 * beside the component, then in each parent directory. A component inside Harper's root stops at that root.
 * `get_studio_configuration` walks the same list, so a plugin's pages come from the directory the loader loads.
 */
export function* packageCandidates(
	componentDirectory: string,
	key: string,
	hdbBasePath: string | undefined
): Generator<string> {
	const insideHdb = componentDirectory === hdbBasePath || componentDirectory.startsWith(hdbBasePath + sep);
	let containerFolder = componentDirectory;
	while (true) {
		yield join(containerFolder, 'node_modules', key);
		const parentFolder = dirname(containerFolder);
		if (parentFolder === containerFolder) return;
		containerFolder = parentFolder;
		if (insideHdb && containerFolder !== hdbBasePath && !containerFolder.startsWith(hdbBasePath + sep)) return;
	}
}
