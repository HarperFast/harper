import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { parse } from 'dotenv';
import YAML from 'yaml';
import logger from '../utility/logging/harper_logger.ts';
import * as hdbUtils from '../utility/common_utils.ts';
import { deriveGlobOptions, type FilesOption } from '../components/deriveGlobOptions.ts';

/** Config-shaping env vars that only take effect from the process environment. */
export const CONFIG_SHAPING_ENV_VARS = ['HARPER_DEFAULT_CONFIG', 'HARPER_CONFIG', 'HARPER_SET_CONFIG'];

/**
 * Detects config-shaping env vars (HARPER_DEFAULT_CONFIG / HARPER_CONFIG / HARPER_SET_CONFIG)
 * delivered via component `.env` files (the loadEnv plugin) and warns loudly that they are NOT
 * applied (#1513). The loadEnv plugin only sets process.env during component load — after
 * getConfigObj() has composed and memoized the config — so these vars silently no-op'd there.
 *
 * They stay unapplied by design: top-level config controls components, not the other way
 * around, so a component must not reach up and shape instance-wide config (see the direction
 * discussion on the fix PR). What this pass fixes is the SILENCE — the operator now gets an
 * actionable warning at boot naming the variable, the file, and the supported channels.
 *
 * Known limitation: componentsRoot is derived from the config file (plus rootPath default), so a
 * componentsRoot override that itself arrives via env var cannot redirect this scan.
 *
 * Never throws: config composition (including install, where none of these dirs exist) must not
 * be broken by a bad component directory.
 *
 * @returns the number of config-shaping vars found (and warned about)
 */
export function warnComponentEnvConfigVars(
	componentsRoot: string | undefined,
	runAppFolder: string | undefined
): number {
	let found = 0;
	for (const componentPath of candidateComponentDirs(componentsRoot, runAppFolder)) {
		const declared = declaredEnvFiles(componentPath);
		for (const envFilePath of declared.envFiles) {
			let parsed;
			try {
				parsed = parse(fs.readFileSync(envFilePath));
			} catch (error) {
				logger.warn(`Could not read env file ${envFilePath} while composing config: ${error.message}`);
				continue;
			}
			for (const key of CONFIG_SHAPING_ENV_VARS) {
				if (parsed[key] === undefined) continue;
				found += 1;
				logger.warn(
					`${key} found in ${envFilePath} is NOT applied: component .env files load after the instance configuration is composed, and components cannot shape instance-wide config. Set ${key} in the process environment, or put the equivalent keys in the instance's harper-config.yaml.`
				);
			}
		}
	}
	return found;
}

/** Resolves a configured path the way getConfigPath does (tilde and rootPath-relative). */
export function resolveConfiguredPath(value: string | undefined, rootPath: string | undefined): string | undefined {
	if (!value || typeof value !== 'string') return undefined;
	if (value.startsWith('~/')) return path.join(hdbUtils.getHomeDir(), value.slice(1));
	if (path.isAbsolute(value)) return value;
	if (!rootPath) return value;
	return path.resolve(rootPath, value);
}

function candidateComponentDirs(componentsRoot: string | undefined, runAppFolder: string | undefined): string[] {
	const dirs: string[] = [];
	try {
		if (componentsRoot && fs.existsSync(componentsRoot)) {
			for (const entry of fs.readdirSync(componentsRoot, { withFileTypes: true })) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				// skip hidden entries, mirroring loadComponentDirectories
				if (entry.name.startsWith('.')) continue;
				dirs.push(path.join(componentsRoot, entry.name));
			}
		}
	} catch (error) {
		logger.warn(`Could not scan components root ${componentsRoot} while composing config: ${error.message}`);
	}
	if (runAppFolder) dirs.push(path.resolve(runAppFolder));
	return dirs;
}

// same precedence as loadComponent's config-file resolution
const COMPONENT_CONFIG_FILENAMES = ['harper-config.yaml', 'harperdb-config.yaml', 'config.yaml'];

function declaredEnvFiles(componentPath: string): { envFiles: string[] } {
	const none = { envFiles: [] };
	let componentConfig;
	for (const configFileName of COMPONENT_CONFIG_FILENAMES) {
		const configFilePath = path.join(componentPath, configFileName);
		if (!fs.existsSync(configFilePath)) continue;
		try {
			componentConfig = YAML.parse(fs.readFileSync(configFilePath, 'utf8'));
		} catch {
			return none; // unparseable — the component loader will report the real error
		}
		break;
	}
	const filesOption = componentConfig?.loadEnv?.files as FilesOption | undefined;
	if (!filesOption) return none;
	try {
		const globOptions = deriveGlobOptions(filesOption);
		// mirror Component's pattern validation: no escaping the component dir, no absolute
		// patterns (the loader throws ComponentInvalidPatternError; the pre-pass just skips —
		// path.isAbsolute additionally covers Windows-style absolutes)
		const source: string[] = [];
		for (const pattern of globOptions.source) {
			if (pattern.includes('..') || pattern.startsWith('/') || path.isAbsolute(pattern)) {
				logger.warn(`Ignoring invalid loadEnv files pattern '${pattern}' in ${componentPath} while composing config`);
				continue;
			}
			source.push(pattern === '.' || pattern === './' ? '**/*' : pattern);
		}
		if (source.length === 0) return none;
		const envFiles = fg.sync(source, {
			cwd: componentPath,
			ignore: globOptions.ignore,
			absolute: true,
			dot: true, // .env is a dotfile
			onlyFiles: true,
		});
		return { envFiles };
	} catch (error) {
		logger.warn(`Could not resolve loadEnv files for ${componentPath} while composing config: ${error.message}`);
		return none;
	}
}
