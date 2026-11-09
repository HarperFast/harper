import { dirname, join, sep } from 'node:path';

/** Shared with `get_studio_configuration`, so a plugin's pages come from the directory the loader loads. */
export function* packageCandidates(
	componentDirectory: string,
	key: string,
	hdbBasePath: string | undefined
): Generator<string> {
	const insideHdb =
		hdbBasePath !== undefined &&
		(componentDirectory === hdbBasePath || componentDirectory.startsWith(hdbBasePath + sep));
	let containerFolder = componentDirectory;
	while (true) {
		yield join(containerFolder, 'node_modules', key);
		const parentFolder = dirname(containerFolder);
		if (parentFolder === containerFolder) return;
		containerFolder = parentFolder;
		if (insideHdb && containerFolder !== hdbBasePath && !containerFolder.startsWith(hdbBasePath + sep)) return;
	}
}
