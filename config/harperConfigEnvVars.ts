/**
 * HARPER_CONFIG, HARPER_DEFAULT_CONFIG and HARPER_SET_CONFIG environment variable support
 *
 * This module provides utilities for applying configuration from environment variables
 * to Harper's configuration system with source tracking and drift detection.
 *
 * The three variables form a precedence ladder (later wins):
 *   HARPER_DEFAULT_CONFIG  <  config file / user edits  <  HARPER_CONFIG  <  HARPER_SET_CONFIG
 *
 * - HARPER_CONFIG (recommended): merge — sets exactly the keys it names, reasserting
 *   them on every boot (a manual edit to a named key is overwritten on restart), and
 *   yields only to HARPER_SET_CONFIG. Individual HARPER_* env vars still win over it
 *   for the keys they name (arg filtering remains SET-only).
 * - HARPER_DEFAULT_CONFIG: defaults — yields to the config file, individual env vars,
 *   and user edits.
 * - HARPER_SET_CONFIG: force — overrides everything and locks against drift.
 *
 * Features:
 * - Install-time and runtime configuration from env vars
 * - Source tracking (which env var set each config value)
 * - Drift detection (detect manual config file edits)
 * - Snapshot-based deletion (remove values when omitted from env var)
 */

import type { Logger } from '../utility/logging/logger.ts';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { cloneDeep } from 'lodash';
import { getBackupDirPath } from './configHelpers.ts';

const STATE_FILE_NAME = '.harper-config-state.json';

/**
 * Get logger instance with tag - lazy loaded to avoid circular dependencies
 * and ensure logger is initialized before use
 */
function getLogger(): Logger {
	const { loggerWithTag } = require('../utility/logging/harper_logger');
	return loggerWithTag('env-config');
}

// Type definitions
type ConfigObject = Record<string, any>;
type ConfigSource = 'HARPER_DEFAULT_CONFIG' | 'HARPER_CONFIG' | 'HARPER_SET_CONFIG' | 'user' | 'default';

/**
 * Configuration state tracking structure
 *
 * Stored in {rootPath}/backup/.harper-config-state.json
 *
 * Example:
 * {
 *   "version": "1.0",
 *   "sources": {
 *     "http.port": "HARPER_DEFAULT_CONFIG",
 *     "http.mtls": "HARPER_SET_CONFIG",
 *     "logging.level": "user"
 *   },
 *   "originalValues": {
 *     "http.port": 9925,
 *     "http.mtls": false
 *   },
 *   "snapshots": {
 *     "HARPER_DEFAULT_CONFIG": {
 *       "hash": "a1b2c3d4",
 *       "config": { "http": { "port": 8080 } }
 *     },
 *     "HARPER_SET_CONFIG": {
 *       "hash": "e5f6g7h8",
 *       "config": { "http": { "mtls": true } }
 *     }
 *   }
 * }
 */
interface ConfigState {
	version: string;
	sources: Record<string, ConfigSource>; // Maps config path to the source that set it
	originalValues: Record<string, any>; // Original values before env var override (for restoration)
	snapshots: {
		// Snapshots of what each env var currently specifies (for detecting changes)
		HARPER_DEFAULT_CONFIG?: { hash: string; config: ConfigObject };
		HARPER_CONFIG?: { hash: string; config: ConfigObject };
		HARPER_SET_CONFIG?: { hash: string; config: ConfigObject };
	};
}

interface ApplyLayerOptions {
	respectSources?: ConfigSource[];
	storeOriginals?: boolean;
}

/**
 * Custom error for configuration environment variable parsing/validation
 */
export class ConfigEnvVarError extends Error {
	envVarName?: string;
	originalError?: Error;

	constructor(message: string, envVarName?: string, originalError?: Error) {
		super(message);
		this.name = 'ConfigEnvVarError';
		this.envVarName = envVarName;
		this.originalError = originalError;
	}
}

/**
 * Check if value is a plain object (not array, not null, not Date, etc.)
 */
function isPlainObject(value: any): value is Record<string, any> {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.prototype.toString.call(value) === '[object Object]'
	);
}

/**
 * Array-composition directive: `{ $union: [...] }`.
 *
 * A "directive" is a plain object that encodes a non-default merge operation for a
 * leaf value instead of the usual overwrite. It is recognized by the presence of a
 * supported directive key (see SUPPORTED_DIRECTIVES), so `flattenObject` treats it as
 * a leaf rather than recursing into `tls.uses.$union`. Other `$`-prefixed keys (e.g. a
 * JSON Schema's `$schema`/`$ref` inside component config) are NOT directives and pass
 * through as ordinary config values.
 *
 * `$union` guarantees the listed items are present in the target array — the
 * order-preserving union of (existing ∪ listed). It is idempotent under repeated
 * application and never removes entries it didn't name, which is what lets a platform
 * layer reapply its required entries on every restart without dropping an app's
 * additions (even on the HARPER_SET_CONFIG force/drift path). We deliberately do not
 * add `$append` (not idempotent) or `$replace` (a bare array already replaces); the
 * vocabulary stays open so further directives can be added non-breaking.
 *
 * Note on HARPER_DEFAULT_CONFIG: a `$union` there composes at install (or against a
 * value DEFAULT previously set), but at runtime DEFAULT yields to an existing
 * un-sourced array and the union no-ops — matching DEFAULT's "only update values we
 * previously set" contract. Use HARPER_SET_CONFIG to compose at runtime.
 */
const DIRECTIVE_UNION = '$union';
const SUPPORTED_DIRECTIVES = [DIRECTIVE_UNION];

/**
 * True if value is a plain object carrying a supported directive key. Detection is
 * deliberately narrowed to the known sentinels (not any `$`-prefixed key) so ordinary
 * config that happens to contain `$`-keys — e.g. a component config embedding a JSON
 * Schema with `$schema`/`$ref` — keeps flattening and applying as plain values.
 */
function isDirectiveObject(value: any): boolean {
	return isPlainObject(value) && SUPPORTED_DIRECTIVES.some((directive) => directive in value);
}

/**
 * Validate a directive object and return its operands. Throws on a malformed directive
 * so misconfiguration surfaces loudly rather than silently misbehaving.
 */
function parseDirective(value: Record<string, any>, path: string): { items: any[] } {
	const keys = Object.keys(value);
	if (keys.length !== 1) {
		throw new ConfigEnvVarError(
			`Config directive "${DIRECTIVE_UNION}" at "${path}" must be the only key, got: ${keys.join(', ')}`
		);
	}
	const items = value[DIRECTIVE_UNION];
	if (!Array.isArray(items)) {
		throw new ConfigEnvVarError(`Config directive "${DIRECTIVE_UNION}" at "${path}" requires an array value`);
	}
	return { items };
}

/**
 * Deterministic JSON string with object keys sorted at every level, so two
 * structurally-equal values compare equal regardless of property insertion order.
 * Shared by snapshot hashing and by `$union`'s idempotent dedup of object entries.
 */
function stableStringify(value: any): string {
	// Honor toJSON (e.g. Date) so values serialize the way JSON.stringify would.
	if (value && typeof value.toJSON === 'function') {
		value = value.toJSON();
	}
	if (value === null || typeof value !== 'object') {
		// undefined/function/symbol stringify to undefined → normalize to 'null' (matches
		// JSON.stringify of an array slot) and keep the declared string return type honest.
		return JSON.stringify(value) ?? 'null';
	}
	if (Array.isArray(value)) {
		return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
	}
	// Match JSON.stringify, which omits keys whose value is undefined/function/symbol.
	const pairs: string[] = [];
	for (const key of Object.keys(value).sort()) {
		const item = value[key];
		if (item !== undefined && typeof item !== 'function' && typeof item !== 'symbol') {
			pairs.push(JSON.stringify(key) + ':' + stableStringify(item));
		}
	}
	return '{' + pairs.join(',') + '}';
}

/**
 * Order-preserving union: existing entries kept in place, listed items appended only
 * when not already present. Idempotent (re-applying is a no-op, no duplicates) and
 * never removes entries the directive didn't name. Dedup uses key-order-insensitive
 * equality so object entries (e.g. `{ port, host }` vs `{ host, port }`) don't
 * re-append across boots.
 */
function unionArrays(current: any, items: any[]): any[] {
	const result = Array.isArray(current) ? [...current] : [];
	// Pre-stringify existing entries once, then stringify each candidate once (O(N+M)).
	const seen = result.map((existing) => stableStringify(existing));
	for (const item of items) {
		const key = stableStringify(item);
		if (!seen.includes(key)) {
			result.push(item);
			seen.push(key);
		}
	}
	return result;
}

/**
 * Resolve the value to write for a flattened leaf given the value currently at that
 * path. Plain leaves overwrite (default); directive leaves compose against current.
 */
function resolveLeafValue(currentValue: any, leafValue: any, path: string): any {
	if (isDirectiveObject(leafValue)) {
		return unionArrays(currentValue, parseDirective(leafValue, path).items);
	}
	return leafValue;
}

/**
 * Filters out arguments that are already set in HARPER_SET_CONFIG.
 * This prevents individual environment variables from overriding runtime configuration.
 *
 * Note: Only filters against HARPER_SET_CONFIG, not HARPER_DEFAULT_CONFIG, since
 * HARPER_DEFAULT_CONFIG sets defaults that can be overridden by individual env vars.
 *
 * @param args - Object containing individual env var arguments (e.g., from assignCMDENVVariables)
 * @returns Filtered args object with HARPER_SET_CONFIG keys removed
 *
 * @example
 * // If HARPER_SET_CONFIG sets operationsApi.network.port
 * const args = { operationsapi_network_port: '9925', rootpath: '/var/hdb' };
 * const filtered = filterArgsAgainstRuntimeConfig(args);
 * // Returns: { rootpath: '/var/hdb' }
 */
export function filterArgsAgainstRuntimeConfig(args: Record<string, any>): Record<string, any> {
	// Only filter against HARPER_SET_CONFIG (not HARPER_DEFAULT_CONFIG)
	if (!process.env.HARPER_SET_CONFIG) {
		return args;
	}

	// Parse HARPER_SET_CONFIG
	let setConfig: ConfigObject;
	try {
		setConfig = JSON.parse(process.env.HARPER_SET_CONFIG);
	} catch (err) {
		// If parsing fails, log warning and return args unchanged
		const logger = getLogger();
		logger.warn('Failed to parse HARPER_SET_CONFIG for arg filtering', err);
		return args;
	}

	// If no valid config, return args unchanged
	if (Object.keys(setConfig).length === 0) {
		return args;
	}

	// Flatten HARPER_SET_CONFIG to get all keys
	const flattenSetConfig = (obj: ConfigObject, prefix = ''): Set<string> => {
		const keys = new Set<string>();
		for (const key in obj) {
			const newKey = prefix ? `${prefix}_${key}` : key;
			if (
				obj[key] !== null &&
				typeof obj[key] === 'object' &&
				!Array.isArray(obj[key]) &&
				!isDirectiveObject(obj[key])
			) {
				flattenSetConfig(obj[key], newKey).forEach((k) => keys.add(k));
			} else {
				keys.add(newKey.toLowerCase());
			}
		}
		return keys;
	};

	const setConfigKeys = flattenSetConfig(setConfig);

	// Filter out args that are in HARPER_SET_CONFIG
	const filteredArgs: Record<string, any> = {};
	for (const key in args) {
		if (!setConfigKeys.has(key.toLowerCase())) {
			filteredArgs[key] = args[key];
		}
	}

	return filteredArgs;
}

/**
 * Flatten nested object to dot-notation paths
 */
function flattenObject(obj: ConfigObject, prefix = ''): Record<string, any> {
	const result: Record<string, any> = {};

	for (const key in obj) {
		if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;

		const value = obj[key];
		const newKey = prefix ? `${prefix}.${key}` : key;

		if (isPlainObject(value) && !isDirectiveObject(value)) {
			// Recurse for nested objects
			Object.assign(result, flattenObject(value, newKey));
		} else {
			// Store primitive, array, or directive ({ $union: [...] }) as a leaf
			result[newKey] = value;
		}
	}

	return result;
}

/**
 * Get nested value by dot-notation path
 */
function getNestedValue(obj: ConfigObject, path: string): any {
	const keys = path.split('.');
	let current = obj;

	for (const key of keys) {
		if (current === null || current === undefined) {
			return undefined;
		}
		current = current[key];
	}

	return current;
}

/**
 * Set nested value by dot-notation path
 */
function setNestedValue(obj: ConfigObject, path: string, value: any): void {
	const keys = path.split('.');
	let current = obj;

	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i];
		if (!isPlainObject(current[key])) {
			current[key] = {};
		}
		current = current[key];
	}

	current[keys[keys.length - 1]] = value;
}

/**
 * Delete nested value by dot-notation path
 */
function deleteNestedValue(obj: ConfigObject, path: string): void {
	const keys = path.split('.');
	let current = obj;

	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i];
		if (!isPlainObject(current[key])) {
			return; // Path doesn't exist
		}
		current = current[key];
	}

	delete current[keys[keys.length - 1]];
}

/**
 * Hash config object for snapshot comparison
 */
function hashConfig(config: ConfigObject): string {
	return crypto.createHash('sha256').update(stableStringify(config)).digest('hex');
}

/**
 * Parse configuration environment variable value
 */
function parseConfigEnvVar(envVarValue: string | undefined, envVarName: string): ConfigObject | null {
	if (!envVarValue || envVarValue.trim() === '') {
		return null;
	}

	try {
		const parsed = JSON.parse(envVarValue.trim());

		if (!isPlainObject(parsed)) {
			throw new ConfigEnvVarError(`${envVarName} must be a JSON object, got: ${typeof parsed}`, envVarName);
		}

		return parsed;
	} catch (error) {
		if (error instanceof ConfigEnvVarError) {
			throw error;
		}

		throw new ConfigEnvVarError(
			`Invalid JSON syntax in ${envVarName}: ${(error as Error).message}`,
			envVarName,
			error as Error
		);
	}
}

/**
 * Load configuration state from file
 */
function loadConfigState(rootPath: string): ConfigState {
	const statePath = path.join(getBackupDirPath(rootPath), STATE_FILE_NAME);

	if (!fs.existsSync(statePath)) {
		return {
			version: '1.0',
			sources: {},
			originalValues: {},
			snapshots: {},
		};
	}

	try {
		const state = fs.readJsonSync(statePath) as ConfigState;
		// Ensure originalValues exists (for backwards compatibility with old state files)
		if (!state.originalValues) {
			state.originalValues = {};
		}
		return state;
	} catch (error) {
		// If state file is corrupted, start fresh
		const logger = getLogger();
		logger.warn(`Failed to load config state file, starting fresh: ${(error as Error).message}`);
		return {
			version: '1.0',
			sources: {},
			originalValues: {},
			snapshots: {},
		};
	}
}

/**
 * Save configuration state to file
 */
function saveConfigState(rootPath: string, state: ConfigState): void {
	const backupDir = getBackupDirPath(rootPath);
	const statePath = path.join(backupDir, STATE_FILE_NAME);

	// Ensure backup directory exists
	fs.ensureDirSync(backupDir);

	fs.writeJsonSync(statePath, state, { spaces: 2 });
}

/**
 * Detect config drift (user manual edits)
 * Compares current file values with expected values from state
 */
function detectConfigDrift(fileConfig: ConfigObject, state: ConfigState): string[] {
	const driftedPaths: string[] = [];

	for (const [path, source] of Object.entries(state.sources)) {
		// Only check paths from env vars (not user or default)
		if (source !== 'HARPER_DEFAULT_CONFIG' && source !== 'HARPER_SET_CONFIG') {
			continue;
		}

		const snapshot = state.snapshots[source];
		if (!snapshot) continue;

		const currentValue = getNestedValue(fileConfig, path);
		const expectedValue = getNestedValue(snapshot.config, path);

		// If values differ, user has edited the file
		if (JSON.stringify(currentValue) !== JSON.stringify(expectedValue)) {
			driftedPaths.push(path);
		}
	}

	return driftedPaths;
}

/**
 * Apply a configuration layer (DEFAULT or SET)
 */
function applyConfigLayer(
	fileConfig: ConfigObject,
	state: ConfigState,
	envConfig: ConfigObject,
	sourceName: ConfigSource,
	options: ApplyLayerOptions = {}
): void {
	const { respectSources = [], storeOriginals = false } = options;
	const flatEnvConfig = flattenObject(envConfig);

	for (const [path, value] of Object.entries(flatEnvConfig)) {
		const currentSource = state.sources[path];
		const currentValue = getNestedValue(fileConfig, path);

		// Skip if this path has a source we should respect
		if (currentSource && respectSources.includes(currentSource)) {
			continue;
		}

		// Store original value if requested and this is first time overriding
		if (storeOriginals && !currentSource && currentValue !== undefined && currentValue !== null) {
			if (!(path in state.originalValues)) {
				state.originalValues[path] = currentValue;
			}
		}

		// Set the value and track the source (directive leaves compose against current,
		// so a $union keeps existing/app entries instead of overwriting them)
		setNestedValue(fileConfig, path, resolveLeafValue(currentValue, value, path));
		state.sources[path] = sourceName;
	}
}

/**
 * Handle deletions when keys are removed from env var
 */
function handleDeletions(
	fileConfig: ConfigObject,
	state: ConfigState,
	previousConfig: ConfigObject,
	currentConfig: ConfigObject,
	sourceName: ConfigSource
): void {
	const previousPaths = Object.keys(flattenObject(previousConfig));
	const currentPaths = Object.keys(flattenObject(currentConfig));

	// Find paths that were in previous but not in current
	const deletedPaths = previousPaths.filter((p) => !currentPaths.includes(p));

	for (const path of deletedPaths) {
		// Only handle if this path was set by this source
		if (state.sources[path] === sourceName) {
			// For all config env vars, restore original value instead of deleting
			if (
				(sourceName === 'HARPER_DEFAULT_CONFIG' ||
					sourceName === 'HARPER_CONFIG' ||
					sourceName === 'HARPER_SET_CONFIG') &&
				path in state.originalValues
			) {
				setNestedValue(fileConfig, path, state.originalValues[path]);
				delete state.originalValues[path];
			} else {
				// For other sources or if no original value, delete
				deleteNestedValue(fileConfig, path);
			}
			delete state.sources[path];
		}
	}
}

/**
 * Remove all values set by a specific source
 */
function removeValuesWithSource(fileConfig: ConfigObject, state: ConfigState, sourceName: ConfigSource): void {
	const pathsToRemove = Object.keys(state.sources).filter((path) => state.sources[path] === sourceName);

	for (const path of pathsToRemove) {
		deleteNestedValue(fileConfig, path);
		delete state.sources[path];
	}
}

/**
 * Build snapshot of values actually set by a source
 */
function buildSnapshot(fileConfig: ConfigObject, state: ConfigState, sourceName: ConfigSource): ConfigObject {
	const actuallySetConfig: ConfigObject = {};
	for (const path in state.sources) {
		if (state.sources[path] === sourceName) {
			const value = getNestedValue(fileConfig, path);
			if (value !== undefined) {
				setNestedValue(actuallySetConfig, path, value);
			}
		}
	}
	return actuallySetConfig;
}

/**
 * Process a config environment variable (parse, apply, track)
 */
function processEnvVar(
	fileConfig: ConfigObject,
	state: ConfigState,
	envVarName: string,
	sourceName: ConfigSource,
	options: {
		isInstall?: boolean;
		respectSources?: ConfigSource[];
	} = {}
): void {
	const envVarValue = process.env[envVarName];
	if (!envVarValue) return;

	const logger = getLogger();
	const parsedConfig = parseConfigEnvVar(envVarValue, envVarName);
	if (!parsedConfig) return;

	const currentHash = hashConfig(parsedConfig);
	const previousSnapshot = state.snapshots[sourceName];

	// Apply the configuration
	if (sourceName === 'HARPER_SET_CONFIG') {
		// SET_CONFIG always overrides everything, but store originals for restoration
		applyConfigLayer(fileConfig, state, parsedConfig, sourceName, {
			respectSources: [],
			storeOriginals: true,
		});
	} else if (sourceName === 'HARPER_CONFIG') {
		// HARPER_CONFIG merges: it sets exactly the keys it names and reasserts them on
		// every boot (winning over the config file, user edits, and DEFAULT), yielding
		// only to HARPER_SET_CONFIG. Same behavior at install and runtime.
		applyConfigLayer(fileConfig, state, parsedConfig, sourceName, {
			respectSources: ['HARPER_SET_CONFIG'],
			storeOriginals: true,
		});
	} else if (sourceName === 'HARPER_DEFAULT_CONFIG') {
		// DEFAULT_CONFIG behavior depends on install vs runtime
		if (options.isInstall) {
			// Install: Override template defaults, but respect other sources
			applyConfigLayer(fileConfig, state, parsedConfig, sourceName, {
				respectSources: ['HARPER_SET_CONFIG', 'user'],
				storeOriginals: true,
			});
		} else {
			// Runtime: Only update values we previously set
			const flatEnvConfig = flattenObject(parsedConfig);
			for (const [path, value] of Object.entries(flatEnvConfig)) {
				const currentSource = state.sources[path];
				const currentValue = getNestedValue(fileConfig, path);

				// Skip if path has a tracked source that's not HARPER_DEFAULT_CONFIG
				if (currentSource && currentSource !== 'HARPER_DEFAULT_CONFIG') {
					continue;
				}

				// At runtime, only set if we previously set this value OR if value doesn't exist
				if (!currentSource) {
					if (currentValue !== undefined && currentValue !== null) {
						// Value exists but we never set it - store as original but don't override
						if (!(path in state.originalValues)) {
							state.originalValues[path] = currentValue;
						}
						continue;
					}
				}

				// Set the value and track the source (directive leaves compose against current)
				setNestedValue(fileConfig, path, resolveLeafValue(currentValue, value, path));
				state.sources[path] = sourceName;
			}
		}
	}

	// Handle deletions if config changed
	if (previousSnapshot && previousSnapshot.hash !== currentHash) {
		handleDeletions(fileConfig, state, previousSnapshot.config, parsedConfig, sourceName);
	}

	// Build and store snapshot
	const actuallySetConfig = buildSnapshot(fileConfig, state, sourceName);
	state.snapshots[sourceName] = {
		hash: currentHash,
		config: actuallySetConfig,
	};

	const mode = options.isInstall ? 'installation' : 'runtime';
	logger.debug?.(`Applied ${envVarName} at ${mode}`);
}

/**
 * Remove all config values set by an environment variable that has been removed
 */
function cleanupRemovedEnvVar(
	fileConfig: ConfigObject,
	state: ConfigState,
	envVarName: string,
	sourceName: ConfigSource
): void {
	if (!state.snapshots[sourceName]) return;

	const logger = getLogger();

	// For all config env vars, restore original values
	if (sourceName === 'HARPER_DEFAULT_CONFIG' || sourceName === 'HARPER_CONFIG' || sourceName === 'HARPER_SET_CONFIG') {
		const pathsToCleanup = Object.keys(state.sources).filter((path) => state.sources[path] === sourceName);
		for (const path of pathsToCleanup) {
			if (path in state.originalValues) {
				// Restore original value
				setNestedValue(fileConfig, path, state.originalValues[path]);
				delete state.originalValues[path];
			} else {
				// No original, just delete
				deleteNestedValue(fileConfig, path);
			}
			delete state.sources[path];
		}
	} else {
		// For other sources, just remove
		removeValuesWithSource(fileConfig, state, sourceName);
	}

	delete state.snapshots[sourceName];
	logger.debug?.(`${envVarName} removed, cleaned up values`);
}

/**
 * Compose a merged config from HARPER_DEFAULT_CONFIG, HARPER_CONFIG and
 * HARPER_SET_CONFIG layered with an optional base. Later layers win:
 *   HARPER_DEFAULT_CONFIG  <  base  <  HARPER_CONFIG  <  HARPER_SET_CONFIG
 *
 * HARPER_DEFAULT_CONFIG provides scaffolding defaults, the base (e.g., the
 * user's existing config file) is layered on top, HARPER_CONFIG merges its
 * keys over that, and HARPER_SET_CONFIG force-overrides everything. This
 * matches the precedence applied by the runtime pipeline in
 * applyRuntimeEnvConfig.
 *
 * Unlike applyRuntimeEnvConfig, this does NOT read or write the config state
 * file and does NOT track sources — it returns a fresh object. Use when you
 * need the effective value of a config key before the state/file wiring is in
 * place (e.g., during clone / pre-install).
 */
export function composeConfigFromEnv(base: ConfigObject = {}): ConfigObject {
	const result: ConfigObject = {};
	const layers: (ConfigObject | null)[] = [
		parseConfigEnvVar(process.env.HARPER_DEFAULT_CONFIG, 'HARPER_DEFAULT_CONFIG'),
		cloneDeep(base),
		parseConfigEnvVar(process.env.HARPER_CONFIG, 'HARPER_CONFIG'),
		parseConfigEnvVar(process.env.HARPER_SET_CONFIG, 'HARPER_SET_CONFIG'),
	];

	for (const layer of layers) {
		if (!layer) continue;
		for (const [p, value] of Object.entries(flattenObject(layer))) {
			// directive leaves compose against the value accumulated by prior layers
			setNestedValue(result, p, resolveLeafValue(getNestedValue(result, p), value, p));
		}
	}

	return result;
}

/**
 * True if a config-state file exists with tracked env-var snapshots. Callers use this to
 * decide whether applyRuntimeEnvConfig must run even when no config env vars are currently
 * set — e.g. to restore originals and clear the snapshot after a var was applied on a prior
 * boot and then removed. Cheap: returns false without reading when no state file exists.
 */
export function hasPersistedEnvConfigState(rootPath: string): boolean {
	return Object.keys(loadConfigState(rootPath).snapshots).length > 0;
}

/**
 * Apply HARPER_DEFAULT_CONFIG, HARPER_CONFIG and HARPER_SET_CONFIG (in that order —
 * later wins). Can be used for both install-time and runtime.
 */
export function applyRuntimeEnvConfig(
	fileConfig: ConfigObject,
	rootPath: string,
	options: { isInstall?: boolean } = {}
): ConfigObject {
	const defaultEnvValue = process.env.HARPER_DEFAULT_CONFIG;
	const configEnvValue = process.env.HARPER_CONFIG;
	const setEnvValue = process.env.HARPER_SET_CONFIG;

	// Load existing state
	const state = loadConfigState(rootPath);

	// No env vars set and no previous state, nothing to do
	if (!defaultEnvValue && !configEnvValue && !setEnvValue && Object.keys(state.snapshots).length === 0) {
		return fileConfig;
	}

	// Detect drift (user manual edits) - only at runtime, not install
	if (!options.isInstall) {
		const driftedPaths = detectConfigDrift(fileConfig, state);
		for (const path of driftedPaths) {
			state.sources[path] = 'user';
		}
	}

	// Clean up any env var that was removed BEFORE applying the remaining ones. A removed
	// var restores its paths to their stored originals and clears ownership; doing this
	// first means a path a higher-precedence var is releasing is already un-sourced when a
	// lower-precedence var (e.g. HARPER_CONFIG) runs, so that var reclaims it the same boot
	// instead of leaving it at the file value for one boot.
	if (!defaultEnvValue) {
		cleanupRemovedEnvVar(fileConfig, state, 'HARPER_DEFAULT_CONFIG', 'HARPER_DEFAULT_CONFIG');
	}
	if (!configEnvValue) {
		cleanupRemovedEnvVar(fileConfig, state, 'HARPER_CONFIG', 'HARPER_CONFIG');
	}
	if (!setEnvValue) {
		cleanupRemovedEnvVar(fileConfig, state, 'HARPER_SET_CONFIG', 'HARPER_SET_CONFIG');
	}

	// Apply present vars in precedence order (later wins):
	//   HARPER_DEFAULT_CONFIG < config file / user edits < HARPER_CONFIG < HARPER_SET_CONFIG
	processEnvVar(fileConfig, state, 'HARPER_DEFAULT_CONFIG', 'HARPER_DEFAULT_CONFIG', options);
	processEnvVar(fileConfig, state, 'HARPER_CONFIG', 'HARPER_CONFIG', options);
	processEnvVar(fileConfig, state, 'HARPER_SET_CONFIG', 'HARPER_SET_CONFIG', options);

	// Save updated state
	saveConfigState(rootPath, state);

	return fileConfig;
}
