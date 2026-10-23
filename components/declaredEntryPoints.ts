// A deploy fails, before its release goes live, when an entry point its own config declares matched nothing in the
// built tree (#1719). A truncated tarball once reported success with half the application missing (#1718); this
// catches that failure whatever its cause. Only the component's own config counts: DEFAULT_CONFIG names optional
// files, and a component without a config file declares nothing.

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import fg from 'fast-glob';
import { parseDocument } from 'yaml';
import { deriveGlobOptions, type FilesOption } from './deriveGlobOptions.ts';
import { ClientError } from '../utility/errors/hdbError.ts';

// The plugins whose files are the application's code and schema, so a declaration that matches nothing is a missing
// application rather than an optional extra.
const ENTRY_POINT_PLUGINS = ['jsResource', 'graphqlSchema'];
// The order componentLoader reads them in.
const CONFIG_FILES = ['harper-config.yaml', 'harperdb-config.yaml', 'config.yaml'];

export async function assertDeclaredEntryPoints(componentName: string, treePath: string): Promise<void> {
	const configFile = CONFIG_FILES.find((name) => existsSync(join(treePath, name)));
	if (!configFile) return;
	let config: any;
	try {
		config = parseDocument(await readFile(join(treePath, configFile), 'utf8')).toJSON();
	} catch {
		// The load reports an unreadable config; this check has nothing to compare against.
		return;
	}
	const missing: string[] = [];
	for (const plugin of ENTRY_POINT_PLUGINS) {
		const files = config?.[plugin]?.files as FilesOption | undefined;
		if (typeof files !== 'string' && (typeof files !== 'object' || files === null)) continue;
		const { source, ignore } = deriveGlobOptions(files);
		for (const pattern of source) {
			if (typeof pattern !== 'string' || pattern.length === 0 || pattern.includes('..')) continue;
			const relative = pattern === '/' ? '.' : pattern.replace(/^\//, '');
			if (!(await matchesAnything(treePath, relative, ignore))) missing.push(`${plugin}.files '${pattern}'`);
		}
	}
	if (missing.length === 0) return;
	throw new ClientError(
		`The release of ${componentName} is missing entry points its ${configFile} declares: ${missing.join(', ')} ` +
			`matched no file. Nothing was made live. Check that the payload carries them; a truncated or partial ` +
			`package reports exactly this.`
	);
}

async function matchesAnything(cwd: string, pattern: string, ignore: string[]): Promise<boolean> {
	// Stops at the first match, so only a pattern that is about to fail walks the whole tree.
	for await (const _match of fg.stream(pattern, { cwd, ignore, dot: true, onlyFiles: false })) return true;
	return false;
}
