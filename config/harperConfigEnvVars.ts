/**
 * HARPER_DEFAULT_CONFIG and HARPER_SET_CONFIG environment variable support
 *
 * This module provides utilities for applying configuration from environment variables
 * to HarperDB's configuration system with source tracking and drift detection.
 *
 * Features:
 * - Install-time and runtime configuration from env vars
 * - Source tracking (which env var set each config value)
 * - Drift detection (detect manual config file edits)
 * - Snapshot-based deletion (remove values when omitted from env var)
 */

import * as fs from 'fs-extra';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getBackupDirPath } from './configHelpers';

const STATE_FILE_NAME = '.harper-config-state.json';

// Type definitions
type ConfigObject = Record<string, any>;
type ConfigSource = 'HARPER_DEFAULT_CONFIG' | 'HARPER_SET_CONFIG' | 'user' | 'default';

interface ConfigState {
	version: string;
	sources: Record<string, ConfigSource>;
	originalValues: Record<string, any>; // Original values before HARPER_DEFAULT_CONFIG override
	snapshots: {
		HARPER_DEFAULT_CONFIG?: { hash: string; config: ConfigObject };
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
 * Flatten nested object to dot-notation paths
 */
function flattenObject(obj: ConfigObject, prefix = ''): Record<string, any> {
	const result: Record<string, any> = {};

	for (const key in obj) {
		if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;

		const value = obj[key];
		const newKey = prefix ? `${prefix}.${key}` : key;

		if (isPlainObject(value)) {
			// Recurse for nested objects
			Object.assign(result, flattenObject(value, newKey));
		} else {
			// Store primitive or array
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
	// Deterministic JSON stringify with sorted keys at all levels
	const sortedStringify = (obj: any): string => {
		if (obj === null || typeof obj !== 'object') {
			return JSON.stringify(obj);
		}
		if (Array.isArray(obj)) {
			return '[' + obj.map(sortedStringify).join(',') + ']';
		}
		const keys = Object.keys(obj).sort();
		const pairs = keys.map((key) => JSON.stringify(key) + ':' + sortedStringify(obj[key]));
		return '{' + pairs.join(',') + '}';
	};

	const json = sortedStringify(config);
	return crypto.createHash('sha256').update(json).digest('hex');
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
		const logger = require('../utility/logging/harper_logger.js');
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

		// Set the value and track the source
		setNestedValue(fileConfig, path, value);
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
			// For HARPER_DEFAULT_CONFIG, restore original value instead of deleting
			if (sourceName === 'HARPER_DEFAULT_CONFIG' && path in state.originalValues) {
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

	const logger = require('../utility/logging/harper_logger.js');
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

				// Set the value and track the source
				setNestedValue(fileConfig, path, value);
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
	logger.debug(`Applied ${envVarName} at ${mode}`);
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

	const logger = require('../utility/logging/harper_logger.js');

	// For both HARPER_DEFAULT_CONFIG and HARPER_SET_CONFIG, restore original values
	if (sourceName === 'HARPER_DEFAULT_CONFIG' || sourceName === 'HARPER_SET_CONFIG') {
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
	logger.debug(`${envVarName} removed, cleaned up values`);
}

/**
 * Apply HARPER_DEFAULT_CONFIG and HARPER_SET_CONFIG
 * Can be used for both install-time and runtime
 */
export function applyRuntimeEnvConfig(
	fileConfig: ConfigObject,
	rootPath: string,
	options: { isInstall?: boolean } = {}
): ConfigObject {
	const defaultEnvValue = process.env.HARPER_DEFAULT_CONFIG;
	const setEnvValue = process.env.HARPER_SET_CONFIG;

	// Load existing state
	const state = loadConfigState(rootPath);

	// No env vars set and no previous state, nothing to do
	if (!defaultEnvValue && !setEnvValue && Object.keys(state.snapshots).length === 0) {
		return fileConfig;
	}

	// Detect drift (user manual edits) - only at runtime, not install
	if (!options.isInstall) {
		const driftedPaths = detectConfigDrift(fileConfig, state);
		for (const path of driftedPaths) {
			state.sources[path] = 'user';
		}
	}

	// Process HARPER_DEFAULT_CONFIG
	processEnvVar(fileConfig, state, 'HARPER_DEFAULT_CONFIG', 'HARPER_DEFAULT_CONFIG', options);

	// Clean up if HARPER_DEFAULT_CONFIG was removed
	if (!defaultEnvValue) {
		cleanupRemovedEnvVar(fileConfig, state, 'HARPER_DEFAULT_CONFIG', 'HARPER_DEFAULT_CONFIG');
	}

	// Process HARPER_SET_CONFIG (always overrides everything)
	processEnvVar(fileConfig, state, 'HARPER_SET_CONFIG', 'HARPER_SET_CONFIG', options);

	// Clean up if HARPER_SET_CONFIG was removed
	if (!setEnvValue) {
		cleanupRemovedEnvVar(fileConfig, state, 'HARPER_SET_CONFIG', 'HARPER_SET_CONFIG');
	}

	// Save updated state
	saveConfigState(rootPath, state);

	return fileConfig;
}
