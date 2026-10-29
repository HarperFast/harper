// Warns, before a deploy's release goes live, when an entry point its own config declares matched nothing in the built
// tree: a truncated or partial payload otherwise reports success with part of the application missing. Warns rather
// than fails, since a config naming a file the release no longer ships is a legal, resource-less component.

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import fg from 'fast-glob';
import { parseDocument } from 'yaml';
import { deriveGlobOptions, type FilesOption } from './deriveGlobOptions.ts';

// Their files are the application's code and schema, so a declaration that matches nothing is a missing application
// rather than an optional extra.
const ENTRY_POINT_PLUGINS = ['jsResource', 'graphqlSchema'];
// In componentLoader's order.
const CONFIG_FILES = ['harper-config.yaml', 'harperdb-config.yaml', 'config.yaml'];

export async function missingEntryPointsWarning(componentName: string, treePath: string): Promise<string | undefined> {
	const configFile = CONFIG_FILES.find((name) => existsSync(join(treePath, name)));
	if (!configFile) return undefined;
	let config: any;
	try {
		config = parseDocument(await readFile(join(treePath, configFile), 'utf8')).toJSON();
	} catch {
		// The load reports an unreadable config.
		return undefined;
	}
	const missing: string[] = [];
	for (const plugin of ENTRY_POINT_PLUGINS) {
		const files = config?.[plugin]?.files as FilesOption | undefined;
		if (typeof files !== 'string' && (typeof files !== 'object' || files === null)) continue;
		const globs = deriveGlobOptions(files);
		// The loader validates these and refuses `..`; anything it would refuse is left to it.
		const usable = (pattern: unknown): pattern is string =>
			typeof pattern === 'string' && pattern.length > 0 && !pattern.includes('..');
		const relative = (pattern: string) => (pattern === '/' ? '.' : pattern.replace(/^\//, ''));
		const source = globs.source.filter(usable);
		// fast-glob reads a negated pattern in `source` as an exclusion of the others, not as one that must match.
		const ignore = [
			...globs.ignore.filter(usable),
			...source.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1)),
		].map(relative);
		for (const pattern of source) {
			if (pattern.startsWith('!')) continue;
			if (!(await matchesAnything(treePath, relative(pattern), ignore, globs)))
				missing.push(`${plugin}.files '${pattern}'`);
		}
	}
	if (missing.length === 0) return undefined;
	return (
		`The release of ${componentName} is missing entry points its ${configFile} declares: ${missing.join(', ')} ` +
		`matched no file. Check that the payload carries them; a truncated or partial package looks exactly like this.`
	);
}

async function matchesAnything(
	cwd: string,
	pattern: string,
	ignore: string[],
	{ onlyFiles, onlyDirectories }: { onlyFiles: boolean; onlyDirectories: boolean }
): Promise<boolean> {
	// The loader's `only` filters (ComponentV1), so what matches here is what it could load. Stops at the first match,
	// so only a pattern that is about to fail walks the whole tree.
	for await (const _match of fg.stream(pattern, { cwd, ignore, dot: true, onlyFiles, onlyDirectories })) return true;
	return false;
}
