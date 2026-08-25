'use strict';

import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import PropertiesReader from 'properties-reader';
import log from '../logging/harper_logger.ts';
import * as commonUtils from '../common_utils.ts';
import * as hdbTerms from '../hdbTerms.ts';
import * as configUtils from '../../config/configUtils.ts';
import { mkdirSync } from 'node:fs';
import { workerData } from 'node:worker_threads';

const INIT_ERR = 'Error initializing environment manager';
const BOOT_PROPS_FILE_PATH = 'BOOT_PROPS_FILE_PATH';

let propFileExists = false;

const installPropsToSave = {
	[hdbTerms.HDB_SETTINGS_NAMES.INSTALL_USER]: true,
	[hdbTerms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY]: true,
	[hdbTerms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY]: true,
	BOOT_PROPS_FILE_PATH: true,
};
let installProps: any = {};
export { BOOT_PROPS_FILE_PATH };

// Every param passed to setProperty() on this thread, keyed by its canonical config param so
// aliases collapse to one last-write-wins entry. Workers inherit this map (getConfigOverrides() and
// the workerDataProvider registration in server/threads/manageThreads.js) and it is replayed after
// a forced config reload; `base` is the configured value the override displaced, which is how
// reapplyAllOverrides() tells a reload that left the param alone from one that is itself the change.
//
// setProperty() therefore means operator/harness *intent* only. Code caching a value it derived
// from config it just read (initializePaths.js, utility/lmdb/environmentUtility.ts) must call
// configUtils.updateConfigObject() directly, or the derived value outlives what it was derived from
// and ships to every worker as an override.
const appliedOverrides = new Map<string, { value: any; base: any }>();
let inheritedOverridesApplied = false;

/**
 * The base path of the HDB install is often referenced, but is referenced as a const variable at the top of many
 * modules.  This is a problem during install, as the path may not yet be defined.  We offer a function to get the
 * currently known base path here to help with this case.
 */
export function getHdbBasePath() {
	return installProps[hdbTerms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY];
}

/**
 * Sets the HDB base path in the install props object that this module maintains.
 * This is mainly used by install during a stage where the config file doesn't exist.
 * @param hdbPath
 */
export function setHdbBasePath(hdbPath: string) {
	installProps[hdbTerms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY] = hdbPath;
}

/**
 * Gets a Harper configuration value.
 * @param propName
 * @returns {*}
 */
export function get(propName: string): any {
	const value = configUtils.getConfigValue(propName);
	if (value === undefined) {
		return installProps[propName];
	}

	return value;
}

/**
 * Will update install props if provided prop is part of that object.
 * Will also update the config object configUtils maintains.
 * Note - this function will NOT update the config file. If you want to update the file
 * use the updateConfigValue method in configUtils.
 *
 * The override is also recorded so it propagates to every worker thread spawned from here and
 * survives a forced config reload — except a reload that changes this param on disk, which wins
 * and retires the override (see reapplyAllOverrides()). `value` must be structured-cloneable.
 *
 * This function should only be used by the installer and unit tests.
 * @param propName
 * @param value
 */
export function setProperty(propName: string, value: any) {
	// Snapshot rather than keep the caller's reference: initializePaths.js and environmentUtility.ts
	// cache derived per-database paths by mutating the live `databases` value in place, which is
	// often the very object handed to setProperty. Cloning here also settles cloneability at the
	// caller that can still fix it — manageThreads.js's provider only logs a clone failure and
	// spawns the worker on the on-disk config anyway.
	let snapshot;
	try {
		snapshot = structuredClone(value);
	} catch (err) {
		throw new Error(`Config property '${propName}' cannot be set to a value that is not structured-cloneable`, {
			cause: err,
		});
	}

	// Key by the canonical param name, not the raw alias passed in: CONFIG_PARAM_MAP is many-to-one
	// (e.g. SERVER_PORT_KEY and OPERATIONSAPI_NETWORK_PORT both canonicalize to
	// 'operationsApi_network_port'), and replay of a stale alias after the canonical one would
	// reintroduce the parent/worker skew this map exists to prevent.
	const canonicalName = (hdbTerms.CONFIG_PARAM_MAP as any)[propName.toLowerCase()] ?? propName;
	const existing = appliedOverrides.get(canonicalName);
	appliedOverrides.set(canonicalName, {
		value: snapshot,
		// Keep the first override's base: everything after it displaced an override, not a
		// configured value, so it says nothing about what the config file held.
		base: existing ? existing.base : snapshotConfigValue(configUtils.getConfigValue(propName)),
	});

	if (installPropsToSave[propName]) {
		installProps[propName] = value;
	}

	configUtils.updateConfigObject(propName, value);
}

/**
 * Every config override applied on this thread via setProperty(), for propagation to worker
 * threads spawned from here (see server/threads/manageThreads.js's 'configOverrides'
 * workerData provider). Returns undefined when nothing has been overridden, so a normal
 * production boot contributes no extra workerData.
 */
export function getConfigOverrides(): Record<string, any> | undefined {
	if (!appliedOverrides.size) return undefined;
	const overrides = {};
	for (const [propName, { value }] of appliedOverrides) {
		overrides[propName] = value;
	}
	return overrides;
}

/**
 * Replays the parent thread's config overrides (received via workerData) on THIS thread, so a
 * worker's effective config matches its parent's rather than silently falling back to whatever
 * is installed on disk. Applied once per thread, right after the on-disk config is first read —
 * see initSync(). A later forced re-init is handled separately by reapplyAllOverrides(), since by
 * then these inherited values are already folded into appliedOverrides.
 */
function applyInheritedConfigOverrides() {
	const inherited = (workerData as any)?.configOverrides;
	if (!inherited) return;
	for (const propName of Object.keys(inherited)) {
		setProperty(propName, inherited[propName]);
	}
}

/** Detached copy of a config value; falls back to the value itself for the (unreached) non-cloneable case. */
function snapshotConfigValue(value: any) {
	try {
		return structuredClone(value);
	} catch {
		return value;
	}
}

/** Key-ordering is a YAML formatting choice, not a config change, so it must not affect equality. */
function stableStringify(value: any) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
		.join(',')}}`;
}

/**
 * A reload rebuilds config values into fresh objects, so identity says nothing about whether the
 * file changed. Anything this cannot serialize (a cyclic value, which structuredClone accepts)
 * counts as changed rather than throwing out of the reload path — initSync()'s catch exits the
 * process.
 */
function sameConfigValue(a: any, b: any) {
	if (Object.is(a, b)) return true;
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
	try {
		return stableStringify(a) === stableStringify(b);
	} catch {
		return false;
	}
}

/**
 * Replays this thread's overrides on top of a config that was just re-read from disk. A forced
 * initSync() rebuilds the whole config, which would otherwise revert the thread to the on-disk
 * config regardless of any overrides — the same defect applyInheritedConfigOverrides() closes for a
 * worker's first boot, but for a reload on any thread, main included.
 *
 * An override does NOT survive a reload that changed its own param on disk. A forced reload is how
 * an operator's config edit takes effect (the RESTART handlers in security/keys.ts and
 * processManagement.js), so replaying unconditionally would make editing an overridden param a
 * silent no-op for the life of the process. The edit is the newer intent, so the override retires
 * entirely — dropped from the map, so it stops reaching newly spawned workers as well.
 *
 * Call only after configUtils.initConfig(force) has repopulated the config from disk.
 */
function reapplyAllOverrides() {
	if (appliedOverrides.size === 0) return;
	// Iterate a snapshot: setProperty() re-inserts into appliedOverrides as we go.
	for (const [propName, { value, base }] of [...appliedOverrides]) {
		if (!sameConfigValue(configUtils.getConfigValue(propName), base)) {
			appliedOverrides.delete(propName);
			log.notify(`Config reload changed '${propName}'; dropping this thread's in-process override of it`);
			continue;
		}
		setProperty(propName, value);
	}
}

/**
 * Checks to see if the Harper boot props file exists.
 * If it does, it grabs the install user and settings path for future reference.
 * @returns {boolean}
 */
function doesPropFileExist() {
	let bootPropPath;
	try {
		bootPropPath = commonUtils.getPropsFilePath();
		fs.accessSync(bootPropPath, fs.constants.F_OK | fs.constants.R_OK);
		propFileExists = true;
		const hdbPropsFile = PropertiesReader(bootPropPath);

		installProps[hdbTerms.HDB_SETTINGS_NAMES.INSTALL_USER] = hdbPropsFile.get(hdbTerms.HDB_SETTINGS_NAMES.INSTALL_USER);
		installProps[hdbTerms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY] = hdbPropsFile.get(
			hdbTerms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY
		);
		installProps[BOOT_PROPS_FILE_PATH] = bootPropPath;

		return true;
	} catch {
		log.trace(`Environment manager found no properties file at ${bootPropPath}`);
		return false;
	}
}

/**
 * Synchronously initializes our config environment.
 * @param force
 */
export function initSync(force: boolean = false) {
	try {
		if (propFileExists || doesPropFileExist() || commonUtils.noBootFile() || force) {
			configUtils.initConfig(force);
			if (!inheritedOverridesApplied) {
				inheritedOverridesApplied = true;
				applyInheritedConfigOverrides();
			}
			// force implies the on-disk config was just re-read from scratch, which would otherwise
			// silently drop every override applied on this thread so far (inherited or local) —
			// except the ones the re-read itself changed, which the config file wins.
			if (force) reapplyAllOverrides();

			// Sync installProps' HDB_ROOT from the config's rootPath *after* any override replay
			// above (not before): setProperty() records a rootPath override under its canonical
			// CONFIG_PARAM_MAP name, not under HDB_ROOT_KEY, so replaying it doesn't retrigger this
			// same side effect below in setProperty() — this sync is what makes getHdbBasePath()
			// track an isolated rootPath override instead of staying pinned to whatever the pre-replay
			// disk read produced.
			const configHdbRoot = configUtils.getConfigValue(hdbTerms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY);
			// Only overwrite if we actually got a value from config
			if (configHdbRoot !== undefined) {
				installProps[hdbTerms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY] = configHdbRoot;
			}
		}
	} catch (err) {
		log.error(INIT_ERR);
		log.error(err);
		console.error(err);
		// Use _realExit so this fatal startup error still terminates the worker
		// even with the worker process guard installed. Inline fallback (rather
		// than importing the helper) avoids a utility -> server layer
		// dependency; safe because both alternatives are real exit primitives.
		(process._realExit ?? process.exit)(1);
	}
}

/**
 * Initializes a test environment.
 * Most of this is legacy code from before the yaml config refactor.
 * @param testConfigObj
 */
export function initTestEnvironment(testConfigObj: any = {}) {
	try {
		const {
			keep_alive_timeout,
			headers_timeout,
			server_timeout,
			https_enabled,
			cors_enabled,
			cors_accesslist,
			local_studio_on,
		} = testConfigObj;
		// __dirname is dist/utility/environment when running tests, so go up 3 levels to reach project root
		const propsPath = path.join(__dirname, '../../../', 'unitTests');
		installProps[BOOT_PROPS_FILE_PATH] = path.join(propsPath, 'hdb_boot_properties.file');
		const TEST_HDB_PATH = path.join(propsPath, 'envDir', process.pid.toString());
		try {
			mkdirSync(TEST_HDB_PATH, { recursive: true });
		} catch {}
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, path.join(propsPath, 'settings.test'));
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.INSTALL_USER, os.userInfo() ? os.userInfo().username : undefined);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.LOG_LEVEL_KEY, `debug`);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.LOG_PATH_KEY, path.join(TEST_HDB_PATH, 'log'));
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.LOG_DAILY_ROTATE_KEY, false);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, TEST_HDB_PATH);
		// same storage layout the unit-test preload pins (see unitTests/mocha.init.js): a
		// re-init through this function must not detach databases seeded under <root>/database
		setProperty(hdbTerms.CONFIG_PARAMS.STORAGE_PATH, path.join(TEST_HDB_PATH, 'database'));

		if (https_enabled) {
			setProperty(hdbTerms.CONFIG_PARAMS.HTTP_SECUREPORT, get(hdbTerms.CONFIG_PARAMS.HTTP_PORT));
			setProperty(hdbTerms.CONFIG_PARAMS.HTTP_PORT, null);
		}
		setProperty(hdbTerms.CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_HTTPS, Boolean(https_enabled));
		setProperty(hdbTerms.CONFIG_PARAMS.HTTP_PORT, 9926);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.SERVER_PORT_KEY, 9925);
		setProperty(hdbTerms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT, 9925);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.CORS_ENABLED_KEY, commonUtils.isEmpty(cors_enabled) ? false : cors_enabled);
		setProperty(hdbTerms.CONFIG_PARAMS.HTTP_CORS, commonUtils.isEmpty(cors_enabled) ? false : cors_enabled);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.MAX_CUSTOM_FUNCTION_PROCESSES, 2);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES, 4);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_PORT_KEY, 9926);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY, true);
		setProperty(
			hdbTerms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY,
			path.join(propsPath, 'server/fastifyRoutes/custom_functions')
		);
		setProperty(
			hdbTerms.HDB_SETTINGS_NAMES.LOCAL_STUDIO_ON,
			commonUtils.isEmpty(local_studio_on) ? false : local_studio_on
		);
		if (cors_accesslist) {
			setProperty('CORS_ACCESSLIST', cors_accesslist);
			setProperty(hdbTerms.CONFIG_PARAMS.HTTP_CORSACCESSLIST, cors_accesslist);
		}
		if (server_timeout) {
			setProperty(hdbTerms.HDB_SETTINGS_NAMES.SERVER_TIMEOUT_KEY, server_timeout);
			setProperty(hdbTerms.CONFIG_PARAMS.HTTP_TIMEOUT, server_timeout);
		}
		if (keep_alive_timeout) {
			setProperty(hdbTerms.HDB_SETTINGS_NAMES.SERVER_KEEP_ALIVE_TIMEOUT_KEY, keep_alive_timeout);
			setProperty(hdbTerms.CONFIG_PARAMS.HTTP_KEEPALIVETIMEOUT, keep_alive_timeout);
		}
		if (headers_timeout) {
			setProperty(hdbTerms.HDB_SETTINGS_NAMES.SERVER_HEADERS_TIMEOUT_KEY, headers_timeout);
			setProperty(hdbTerms.CONFIG_PARAMS.HTTP_HEADERSTIMEOUT, headers_timeout);
		}
	} catch (err) {
		let msg = `Error reading in HDB environment variables from path ${BOOT_PROPS_FILE_PATH}.  Please check your boot props and settings files`;
		log.fatal(msg);
		log.error(err);
	}
}
