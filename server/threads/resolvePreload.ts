import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import { getConfigPath } from '../../config/configUtils.ts';
import * as env from '../../utility/environment/environmentManager.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import { PACKAGE_ROOT } from '../../utility/packageUtils.js';

// Resolve the `threads.preload` config to absolute file paths. Bare specifiers are
// resolved against installed components' `node_modules` so an instrumentation package
// (e.g. `dd-trace/init`) bundled in a deployed component can be preloaded via `--require`
// before any Harper or app module in a worker thread — the only point early enough for
// an APM agent to instrument subsequent module loads. Runs on the main thread at worker
// spawn (where config is available synchronously); the caller memoizes the result since
// the config and installed components are fixed for the process lifetime.
export function resolvePreloadModules(): string[] {
	const configured = env.get(CONFIG_PARAMS.THREADS_PRELOAD);
	if (configured == null) return [];
	const specifiers = (Array.isArray(configured) ? configured : [configured]).filter(
		(specifier) => typeof specifier === 'string' && specifier.length > 0
	);
	if (specifiers.length === 0) return [];

	const anchors = getResolutionAnchors();
	const resolved: string[] = [];
	for (const specifier of specifiers) {
		const path = resolveSpecifier(specifier, anchors);
		if (path) resolved.push(path);
		else
			harperLogger.warn(
				`Could not resolve threads.preload module "${specifier}"; it will not be preloaded. It must be an ` +
					`absolute path or a package installed in a deployed component.`
			);
	}
	if (resolved.length > 0) harperLogger.trace(`Preloading modules on worker threads: ${resolved.join(', ')}`);
	return resolved;
}

// Anchor files (which need not exist — `createRequire` only uses them to root a
// `node_modules` search) ordered most-specific first: each installed component, then
// the components root and the Harper install itself as fallbacks.
function getResolutionAnchors(): string[] {
	const anchors: string[] = [];
	const componentsRoot = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
	if (typeof componentsRoot === 'string') {
		try {
			for (const entry of readdirSync(componentsRoot, { withFileTypes: true })) {
				if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
				anchors.push(join(componentsRoot, entry.name, 'index.js'));
			}
			anchors.push(join(componentsRoot, 'index.js'));
		} catch {
			// components root missing or unreadable; fall back to the app folder and Harper install
		}
	}
	const appFolder = process.env.RUN_HDB_APP;
	if (appFolder) anchors.push(join(appFolder, 'index.js'));
	anchors.push(join(PACKAGE_ROOT, 'index.js'));
	return anchors;
}

function resolveSpecifier(specifier: string, anchors: string[]): string | undefined {
	if (isAbsolute(specifier)) return existsSync(specifier) ? specifier : undefined;
	// Relative paths are rejected: they would resolve against whichever anchor matched
	// first (non-deterministic). The contract is an absolute path or a package installed
	// in a deployed component.
	if (specifier.startsWith('.')) return undefined;
	for (const anchor of anchors) {
		try {
			return createRequire(anchor).resolve(specifier);
		} catch {
			// specifier not resolvable from this anchor; try the next
		}
	}
	return undefined;
}
