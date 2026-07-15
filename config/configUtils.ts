import * as hdbTerms from '../utility/hdbTerms.ts';
import * as hdbUtils from '../utility/common_utils.ts';
import logger from '../utility/logging/harper_logger.ts';
import { configValidator } from '../validation/configValidator.ts';
import fs from 'fs-extra';
import YAML from 'yaml';
import path from 'path';
import { threadId } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import isNumber from 'is-number';
import propertiesReaderModule from 'properties-reader';
import _ from 'lodash';

// Aliased to a mutable, module-scoped binding so unit tests can swap the
// implementation via rewire. The compiled default-import binding is otherwise
// not addressable by name, and a default-exported CJS callable cannot be stubbed
// through its shared module object the way named exports can.
// eslint-disable-next-line prefer-const
let PropertiesReader = propertiesReaderModule;
import { handleHDBError } from '../utility/errors/hdbError.ts';
import { HTTP_STATUS_CODES, HDB_ERROR_MSGS } from '../utility/errors/commonErrors.ts';
import { server } from '../server/Server.ts';
import { getBackupDirPath } from './configHelpers.ts';
import { PACKAGE_ROOT } from '../utility/packageUtils.js';
import * as env from '../utility/environment/environmentManager.ts';
import { applyRuntimeEnvConfig, hasPersistedEnvConfigState } from './harperConfigEnvVars.ts';
import { warnComponentEnvConfigVars, resolveConfiguredPath } from './componentEnvPrepass.ts';

const { DATABASES_PARAM_CONFIG, CONFIG_PARAMS, CONFIG_PARAM_MAP } = hdbTerms;
const UNINIT_GET_CONFIG_ERR = 'Unable to get config value because config is uninitialized';
const CONFIG_INIT_MSG = 'Config successfully initialized';
const BACKUP_ERR = 'Error backing up config file';
const EMPTY_GET_VALUE = 'Empty parameter sent to getConfigValue';
const DEFAULT_CONFIG_FILE_PATH = path.join(PACKAGE_ROOT, 'static', hdbTerms.HDB_DEFAULT_CONFIG_FILE);

const CONFIGURE_SUCCESS_RESPONSE =
	'Configuration successfully set. You must restart Harper for new config settings to take effect.';

const DEPRECATED_CONFIG = {
	logging_rotation_retain: 'logging.rotation.retain',
	logging_rotation_rotate: 'logging.rotation.rotate',
	logging_rotation_rotateinterval: 'logging.rotation.rotateInterval',
	logging_rotation_rotatemodule: 'logging.rotation.rotateModule',
	logging_rotation_timezone: 'logging.rotation.timezone',
	logging_rotation_workerinterval: 'logging.rotation.workerInterval',
};

let flatDefaultConfigObj;
let flatConfigObj;
let configObj;

export function resolvePath(relativePath: string) {
	if (relativePath?.startsWith('~/')) {
		return path.join(hdbUtils.getHomeDir(), relativePath.slice(1));
	}
	try {
		return path.resolve(env.getHdbBasePath(), relativePath);
	} catch (error) {
		console.error('Unable to resolve path', relativePath, error);
		return relativePath;
	}
}
/**
 * Get a config value and resolve it as a path relative to rootPath.
 * Use this for any config param that represents a file/directory path.
 * @param param
 */
export function getConfigPath(param: string) {
	const value = env.get(param);
	if (!value || typeof value !== 'string') return value;
	if (value.startsWith('~/')) {
		return path.join(hdbUtils.getHomeDir(), value.slice(1));
	}
	if (path.isAbsolute(value)) return value;
	const rootPath = env.getHdbBasePath();
	if (!rootPath) return value;
	return path.resolve(rootPath, value);
}

// Write atomically via temp file + rename so readers don't observe a truncated/empty file.
// Temp path includes randomness so two worker threads in the same process (same pid) writing
// in the same millisecond can't collide on the temp name and then race the rename.
function atomicWriteFile(filePath, content) {
	const tempPath = `${filePath}.${process.pid}.${threadId}.${randomBytes(4).toString('hex')}.tmp`;
	fs.writeFileSync(tempPath, content);
	let retries = 5;
	while (true) {
		try {
			fs.renameSync(tempPath, filePath);
			break;
		} catch (err) {
			if (retries > 0 && (err.code === 'EPERM' || err.code === 'EACCES')) {
				retries--;
				// sleep synchronously to allow the reader to close the file
				const start = Date.now();
				while (Date.now() - start < 10) {}
				continue;
			}
			// if it fails we should clean up the tmp file
			try {
				fs.unlinkSync(tempPath);
			} catch {
				// ignore cleanup errors
			}
			throw err;
		}
	}
}

/**
 * Builds the Harper config file using user inputs and default values from defaultConfig.yaml
 * @param args - any args that the user provided.
 */
export function createConfigFile(args, skipFsValidation = false) {
	const configDoc = parseYamlDoc(DEFAULT_CONFIG_FILE_PATH);

	flatDefaultConfigObj = flattenConfig(configDoc.toJSON());

	// Loop through the user inputted args. Match them to a parameter in the default config file and update value.
	let schemasArgs;
	for (const arg in args) {
		let configParam = CONFIG_PARAM_MAP[arg.toLowerCase()];

		// Schemas config args are handled differently, so if they exist set them to var that will be used by setSchemasConfig
		if (configParam === CONFIG_PARAMS.DATABASES) {
			if (Array.isArray(args[arg])) {
				schemasArgs = args[arg];
			} else {
				schemasArgs = Object.keys(args[arg]).map((key) => {
					return { [key]: args[arg][key] };
				});
			}

			continue;
		}

		if (!configParam && (arg.endsWith('_package') || arg.endsWith('_port'))) {
			configParam = arg;
		}

		if (configParam !== undefined) {
			const splitParam = configParam.split('_');
			let value = castConfigValue(configParam, args[arg]);
			if (configParam === 'rootPath' && value?.endsWith('/')) value = value.slice(0, -1);
			try {
				// Remove parent structure if it's a boolean to avoid type conflicts when setting the new value
				if (splitParam.length > 1 && typeof configDoc.getIn(splitParam.slice(0, -1)) === 'boolean') {
					configDoc.deleteIn(splitParam.slice(0, -1));
				}

				configDoc.setIn([...splitParam], value);
			} catch (err) {
				logger.error(err);
			}
		}
	}

	if (schemasArgs) setSchemasConfig(configDoc, schemasArgs);

	// Apply HARPER_DEFAULT_CONFIG, HARPER_CONFIG and HARPER_SET_CONFIG environment variables BEFORE validation
	// This allows runtime env vars to resolve port conflicts before validation
	// Must be called AFTER rootPath is set in configDoc
	// Mutates configDoc in place
	applyRuntimeEnvVarConfig(configDoc, null, { isInstall: true });

	// Validates config doc and if required sets default values for some parameters.
	validateConfig(configDoc, skipFsValidation);

	const configObj = configDoc.toJSON();
	flatConfigObj = flattenConfig(configObj);

	// Create new config file and write config doc to it.
	const hdbRoot = configDoc.getIn(['rootPath']) as string;
	const configFilePath = path.join(hdbRoot, hdbTerms.HARPER_CONFIG_FILE);
	fs.createFileSync(configFilePath);
	if (configDoc.errors?.length > 0) {
		throw handleHDBError(
			new Error(),
			`Error parsing ${configFilePath} ${configDoc.errors}`,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
	atomicWriteFile(configFilePath, String(configDoc));
	logger.trace(`Config file written to ${configFilePath}`);
}

/**
 * Sets any schema/table location config that belongs under the 'schemas' config element.
 * @param configDoc
 * @param schemaConfJson
 */
function setSchemasConfig(configDoc, schemaConfJson) {
	let schemasConf;
	try {
		try {
			schemasConf = JSON.parse(schemaConfJson);
		} catch (err) {
			if (!hdbUtils.isObject(schemaConfJson)) throw err;
			schemasConf = schemaConfJson;
		}

		for (const schemaConf of schemasConf) {
			const schema = Object.keys(schemaConf)[0];
			if (schemaConf[schema].hasOwnProperty(DATABASES_PARAM_CONFIG.TABLES)) {
				for (const table in schemaConf[schema][DATABASES_PARAM_CONFIG.TABLES]) {
					// Table path var can be 'path' or 'auditPath'
					for (const tablePathVar in schemaConf[schema][DATABASES_PARAM_CONFIG.TABLES][table]) {
						const tablePath = schemaConf[schema][DATABASES_PARAM_CONFIG.TABLES][table][tablePathVar];
						const keys = [CONFIG_PARAMS.DATABASES, schema, DATABASES_PARAM_CONFIG.TABLES, table, tablePathVar];
						configDoc.hasIn(keys) ? configDoc.setIn(keys, tablePath) : configDoc.addIn(keys, tablePath);
					}
				}
			} else {
				// Schema path var can be 'path' or 'auditPath'
				for (const schemaPathVar in schemaConf[schema]) {
					const schemaPath = schemaConf[schema][schemaPathVar];
					const keys = [CONFIG_PARAMS.DATABASES, schema, schemaPathVar];
					configDoc.hasIn(keys) ? configDoc.setIn(keys, schemaPath) : configDoc.addIn(keys, schemaPath);
				}
			}
		}
	} catch (err) {
		logger.error('Error parsing schemas CLI/env config arguments', err);
	}
}

/**
 * Get a default config value from in memory object.
 * If object is undefined read the default config yaml and instantiate default config obj.
 * @param param
 * @returns {*}
 */
export function getDefaultConfig(param: string) {
	if (flatDefaultConfigObj === undefined) {
		const configDoc = parseYamlDoc(DEFAULT_CONFIG_FILE_PATH);
		flatDefaultConfigObj = flattenConfig(configDoc.toJSON());
	}

	const paramMap = CONFIG_PARAM_MAP[param.toLowerCase()];
	if (paramMap === undefined) return undefined;

	return flatDefaultConfigObj[paramMap.toLowerCase()];
}

/**
 * Get config value from in memory flattened config obj.
 * This functions depends on the config obj being initialized.
 * We do not want it to get value directly from config file as this adds unnecessary overhead.
 * @param param
 * @returns {undefined|*}
 */
export function getConfigValue(param: string | null | undefined) {
	if (param == null) {
		logger.info(EMPTY_GET_VALUE);
		return undefined;
	}

	if (flatConfigObj === undefined) {
		logger.trace(UNINIT_GET_CONFIG_ERR);
		return undefined;
	}

	const paramMap = CONFIG_PARAM_MAP[param.toLowerCase()];
	if (paramMap === undefined) return undefined;

	return flatConfigObj[paramMap.toLowerCase()];
}

export function getConfigFilePath(bootPropsFilePath = hdbUtils.getPropsFilePath()) {
	const cmdArgs = hdbUtils.getEnvCliRootPath();
	if (cmdArgs) {
		let harperConfigPath = resolvePath(path.join(cmdArgs, hdbTerms.HARPER_CONFIG_FILE));
		if (fs.existsSync(harperConfigPath)) return harperConfigPath;
		if (fs.existsSync(resolvePath(path.join(cmdArgs, hdbTerms.HDB_CONFIG_FILE))))
			return resolvePath(path.join(cmdArgs, hdbTerms.HDB_CONFIG_FILE));
		return harperConfigPath;
	}
	const hdbProperties = PropertiesReader(bootPropsFilePath);
	return resolvePath(hdbProperties.get(hdbTerms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY) as string);
}

/**
 * Ensure the given top-level keys exist in the on-disk config file, writing an empty block (`{}`)
 * for each one that is absent. Only missing keys are added — existing values are never touched.
 *
 * Built-in components only load when their config key is present: componentLoader iterates the
 * resolved config's keys, so a registered built-in with no matching key is never activated. Fresh
 * installs get those keys from defaultConfig.yaml, but an in-place upgrade carries the pre-existing
 * config forward, so a built-in introduced in a newer release (e.g. `secretCustody` in 5.2) stays
 * dormant until its key appears. This restores parity with a fresh install. Callers pass the keys
 * for the built-ins registered in THIS runtime, so nothing is added for a component the running
 * distribution doesn't ship.
 *
 * @param keys - top-level config keys to ensure exist
 * @returns the keys that were added (empty when none were missing)
 */
export function ensureConfigKeysPresent(keys: string[]): string[] {
	const configFilePath = getConfigFilePath();
	if (!configFilePath || !fs.existsSync(configFilePath)) return [];

	const configDoc = parseYamlDoc(configFilePath);
	const added: string[] = [];
	for (const key of keys) {
		if (!key || configDoc.hasIn([key])) continue;
		configDoc.setIn([key], {});
		added.push(key);
	}
	if (added.length === 0) return [];

	if (configDoc.errors?.length > 0) {
		throw handleHDBError(
			new Error(),
			`Error parsing ${configFilePath} ${configDoc.errors}`,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR
		);
	}
	atomicWriteFile(configFilePath, String(configDoc));

	// Mirror the additions into the already-memoized config so a built-in gated on the new key
	// activates on the CURRENT boot: componentLoader reads the root config from getConfigObj(),
	// which is cached early in boot — before an upgrade backfill runs — so a file-only write would
	// otherwise not take effect until the next restart.
	if (configObj) {
		for (const key of added) {
			if (configObj[key] === undefined) configObj[key] = {};
		}
	}
	return added;
}

/**
 * Built-in components introduced in a recent release whose config key must be backfilled onto
 * in-place-upgraded instances. Fresh installs get these from defaultConfig.yaml, but an upgrade
 * carries the old config forward without them, leaving the component dormant (harper-pro#585:
 * secretCustody added in 5.2).
 *
 * Deliberately scoped to genuinely-new built-ins — NOT every registered built-in. Component
 * activation is presence-gated (componentLoader iterates the config's keys), so re-adding a
 * long-standing key like `replication` would silently re-enable a component an operator disabled
 * by deleting its block. A newly-introduced built-in has no such history: its absence is always
 * "carried over from before it existed," never "intentionally removed." Add a key here only when
 * shipping a new built-in that must activate on already-upgraded instances.
 */
const UPGRADE_BACKFILL_BUILTIN_KEYS = ['secretCustody'];

/**
 * Ensure the config keys for recently-introduced built-in components exist, so a component added in
 * a newer release activates on an in-place-upgraded instance (see UPGRADE_BACKFILL_BUILTIN_KEYS).
 * Only keys for built-ins registered in THIS runtime (HARPER_BUILTIN_COMPONENTS) are considered, so
 * nothing is written for a component the running distribution doesn't ship — e.g. secretCustody is
 * Pro-only and is never added on OSS core, which registers no built-ins.
 *
 * Safe to call on every boot: idempotent (writes only when a key is genuinely missing) and cheap (a
 * config read plus a key check). Running it unconditionally — rather than only on the upgrade path —
 * means a transient write failure self-heals on the next boot, and version transitions that ship no
 * data-migration directive are still covered. Never throws.
 *
 * @returns the keys that were added (empty when none were missing)
 */
export function ensureBuiltInComponentConfigKeys(): string[] {
	const registeredBuiltIns = process.env.HARPER_BUILTIN_COMPONENTS;
	if (!registeredBuiltIns) return [];
	const registered = new Set(
		registeredBuiltIns
			.split(',')
			.map((definition) => definition.split('=')[0].trim())
			.filter(Boolean)
	);
	const keys = UPGRADE_BACKFILL_BUILTIN_KEYS.filter((key) => registered.has(key));
	if (keys.length === 0) return [];
	try {
		return ensureConfigKeysPresent(keys);
	} catch (error) {
		logger.error('Failed to backfill built-in component config keys', error);
		return [];
	}
}

/**
 * If in memory config obj is undefined or init is being forced,
 * read and parses the Harper config file and add to config object.
 * @param force
 */
export function initConfig(force = false) {
	if (flatConfigObj === undefined || force) {
		let bootPropsFilePath;
		if (!hdbUtils.noBootFile()) {
			bootPropsFilePath = hdbUtils.getPropsFilePath();
			try {
				fs.accessSync(bootPropsFilePath, fs.constants.F_OK | fs.constants.R_OK);
			} catch (err) {
				logger.error(err);
				throw handleHDBError(
					new Error(),
					`Harper properties file at path ${bootPropsFilePath} does not exist`,
					HTTP_STATUS_CODES.BAD_REQUEST
				);
			}
		}

		const configFilePath = getConfigFilePath(bootPropsFilePath);
		let configDoc;

		// if this is true, user is upgrading from version prior to 4.0.0. We need to initialize existing
		// params.
		if (configFilePath.includes('config/settings.js')) {
			try {
				initOldConfig(configFilePath);
				return;
			} catch (initErr) {
				// If user has an old boot prop file but hdb is not installed init old config will throw ENOENT error.
				// We want to squash that error so that new version of HDB can be installed.
				if (initErr.code !== hdbTerms.NODE_ERROR_CODES.ENOENT) throw initErr;
			}
		}
		try {
			configDoc = parseYamlDoc(configFilePath);
		} catch (err) {
			if (err.code === hdbTerms.NODE_ERROR_CODES.ENOENT) {
				logger.trace(`Harper config file not found at ${configFilePath}. 
				This can occur during early stages of install where the config file has not yet been created`);
				return;
			} else {
				logger.error(err);
				throw handleHDBError(
					new Error(),
					`Error reading Harper config file at ${configFilePath}`,
					HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR
				);
			}
		}

		checkForUpdatedConfig(configDoc, configFilePath);

		// Config-shaping env vars delivered via component .env files (loadEnv) cannot take effect —
		// warn loudly instead of silently no-opping (#1513; components must not shape instance config)
		try {
			// the config file lives in the root directory, so its dirname is the authoritative base:
			// it also anchors a relative or missing rootPath value in the config doc
			const configFileDir = path.dirname(configFilePath);
			const rootPath = path.resolve(
				configFileDir,
				resolveConfiguredPath(configDoc.getIn(['rootPath']) as string | undefined, configFileDir) ?? configFileDir
			);
			const componentsRoot =
				resolveConfiguredPath(
					(configDoc.getIn(['componentsRoot']) ?? configDoc.getIn(['customFunctions', 'root'])) as string | undefined,
					rootPath
				) ?? path.join(rootPath, 'components');
			warnComponentEnvConfigVars(componentsRoot, process.env.RUN_HDB_APP);
		} catch (error) {
			logger.warn(`Could not scan component .env files for config vars: ${error.message}`);
		}

		// Apply HARPER_DEFAULT_CONFIG, HARPER_CONFIG and HARPER_SET_CONFIG environment variables
		applyRuntimeEnvVarConfig(configDoc, configFilePath);

		// Validates config doc and if required sets default values for some parameters.
		validateConfig(configDoc);
		const configObj = configDoc.toJSON();
		(server as any).config = configObj;
		flatConfigObj = flattenConfig(configObj);

		// If config has old version of logrotate enabled let user know it has been deprecated.
		if (flatConfigObj['logging_rotation_rotate']) {
			for (const key in DEPRECATED_CONFIG) {
				if (flatConfigObj[key])
					logger.error(
						`Config ${DEPRECATED_CONFIG[key]} has been deprecated. Please check https://docs.harperdb.io/docs/ for further details.`
					);
			}
		}

		logger.trace(CONFIG_INIT_MSG);
	}
}

/**
 * When running an upgraded version there is a chance these config params won't exist.
 * To address this we check for them and write them to config file if needed.
 * @param configDoc
 * @param configFilePath
 */
function checkForUpdatedConfig(configDoc, configFilePath) {
	let updateFile = false;
	if (!configDoc.hasIn(['storage', 'path'])) {
		configDoc.setIn(['storage', 'path'], 'database');
		updateFile = true;
	}

	if (!configDoc.hasIn(['logging', 'rotation', 'path'])) {
		configDoc.setIn(['logging', 'rotation', 'path'], 'log');
		updateFile = true;
	}

	if (!configDoc.hasIn(['authentication'])) {
		configDoc.addIn(['authentication'], {
			cacheTTL: 30000,
			enableSessions: true,
			operationTokenTimeout: configDoc.getIn(['operationsApi', 'authentication', 'operationTokenTimeout']) ?? '1d',
			refreshTokenTimeout: configDoc.getIn(['operationsApi', 'authentication', 'refreshTokenTimeout']) ?? '30d',
		});

		updateFile = true;
	}

	if (!configDoc.hasIn(['analytics'])) {
		configDoc.addIn(['analytics'], {
			aggregatePeriod: 60,
			replicate: false,
		});

		updateFile = true;
	}

	if (updateFile) {
		logger.trace('Updating config file with missing config params');
		if (configDoc.errors?.length > 0) {
			throw handleHDBError(
				new Error(),
				`Error parsing harperdb-config.yaml ${configDoc.errors}`,
				HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR
			);
		}
		atomicWriteFile(configFilePath, String(configDoc));
	}
}

/**
 * Validates the config doc and adds any default values to doc.
 * NOTE - If any default values are set in configValidator they also need to be 'setIn' in this function.
 * @param configDoc
 */
function validateConfig(configDoc, skipFsValidation = false) {
	const configJson = configDoc.toJSON();

	// Config might have some legacy values that will be modified by validator. We need to set old to new here before
	// validator sets any defaults
	configJson.componentsRoot = configJson.componentsRoot ?? configJson?.customFunctions?.root;
	if (configJson?.http?.threads) configJson.threads = configJson?.http?.threads;

	if (configJson.http?.port && configJson.http?.port === configJson.http?.securePort) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.CONFIG_VALIDATION('http.port and http.securePort cannot be the same value'),
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	if (
		configJson.operationsApi?.network?.port &&
		configJson.operationsApi?.network?.port === configJson.operationsApi?.network?.securePort
	) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.CONFIG_VALIDATION(
				'operationsApi.network.port and operationsApi.network.securePort cannot be the same value'
			),
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	// The operations API and the REST/http servers are distinct servers that cannot share a port. The operations API
	// runs on the main thread without SO_REUSEPORT while the http servers run on the workers with it, so a shared port is
	// silently claimed by whichever binds first (the operations server), leaving the http server — and its WebSocket
	// upgrade handler — unable to bind. That presents as secure-port WebSocket upgrades hanging. Fail loudly here rather
	// than letting the collision go undetected. (mqtt websocket intentionally shares http.port and replication defaults
	// to the operations port, so only the http/operationsApi pairing is checked.) See issue #1412.
	const configuredPorts = [
		['http.port', configJson.http?.port],
		['http.securePort', configJson.http?.securePort],
		['operationsApi.network.port', configJson.operationsApi?.network?.port],
		['operationsApi.network.securePort', configJson.operationsApi?.network?.securePort],
	];
	const portLabels = new Map();
	for (const [label, value] of configuredPorts) {
		// Skip non-numeric values (unset, or a malformed boolean/array/object) — those are caught by the schema
		// validator below. Numeric strings pass (isNumber('9926') === true) so a string env-var port still matches a
		// numeric YAML port. Skip 0: it requests an OS-assigned port, so distinct sections set that way won't collide.
		if (!isNumber(value)) continue;
		const port = Number(value);
		if (port === 0) continue;
		const collidingLabel = portLabels.get(port);
		// Skip http-internal and operationsApi-internal collisions; those are reported with dedicated messages above.
		if (collidingLabel && collidingLabel.split('.')[0] !== label.split('.')[0]) {
			throw handleHDBError(
				new Error(),
				HDB_ERROR_MSGS.CONFIG_VALIDATION(`${collidingLabel} and ${label} cannot be the same value (${port})`),
				HTTP_STATUS_CODES.BAD_REQUEST,
				undefined,
				undefined,
				true
			);
		}
		portLabels.set(port, label);
	}

	const validation = configValidator(configJson, skipFsValidation);
	if (validation.error) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.CONFIG_VALIDATION(validation.error.message),
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	// These parameters can be set by the validator if they arent provided by user,
	// for this reason we need to update the config yaml doc after the validator has run.
	if (typeof validation.value.threads === 'object')
		configDoc.setIn(['threads', 'count'], validation.value.threads.count);
	else configDoc.setIn(['threads'], validation.value.threads);
	configDoc.setIn(['componentsRoot'], validation.value.componentsRoot); // TODO: check this works with old config
	configDoc.setIn(['logging', 'root'], validation.value.logging.root);
	configDoc.setIn(['storage', 'path'], validation.value.storage.path);
	configDoc.setIn(['logging', 'rotation', 'path'], validation.value.logging.rotation.path);
	configDoc.setIn(['operationsApi', 'network', 'domainSocket'], validation.value?.operationsApi?.network?.domainSocket);
}

/**
 * Updates the in memory flattened config object. Does not update the config file.
 * This is mainly here to accommodate older versions of environmentManager and unit tests.
 * @param param
 * @param value
 */
export function updateConfigObject(param: string, value: any) {
	if (flatConfigObj === undefined) {
		// This is here to allow unit tests to work when HDB is not installed.
		flatConfigObj = {};
	}

	const configObjKey = CONFIG_PARAM_MAP[param.toLowerCase()];
	if (configObjKey === undefined) {
		logger.trace(`Unable to update config object because config param '${param}' does not exist`);
		return;
	}

	flatConfigObj[configObjKey.toLowerCase()] = value;
}

/**
 * Updates and validates a config value in config file. Can also create a backup of config before updating.
 * @param param - the config value to update
 * @param value - the value to set the config to
 * @param parsedArgs - an object of param/values to update
 * @param createBackup - if true backup file is created
 * @param update_config_obj - if true updates the in memory flattened config object
 */
export function updateConfigValue(
	param: string,
	value: any,
	parsedArgs = undefined,
	createBackup = false,
	update_config_obj = false,
	skipParamMap = false
) {
	if (flatConfigObj === undefined) {
		initConfig();
	}

	// Old root/path is used just in case they are updating the operations api root.
	const oldHdbRoot = getConfigValue(CONFIG_PARAM_MAP.hdb_root);
	let oldConfigPath = path.join(oldHdbRoot, hdbTerms.HARPER_CONFIG_FILE);
	if (!fs.existsSync(oldConfigPath) && fs.existsSync(path.join(oldHdbRoot, hdbTerms.HDB_CONFIG_FILE))) {
		oldConfigPath = path.join(oldHdbRoot, hdbTerms.HDB_CONFIG_FILE);
	}

	const configDoc = parseYamlDoc(oldConfigPath);
	let schemasArgs;

	// Don't do the update if the values are the same.
	// Env vars arrive as strings ('true', '9925', '["x"]'); flatConfigObj has
	// typed values (true, 9925, ['x']). Run the env value through castConfigValue
	// — the same coercion the write path applies below — and deep-compare. Plain
	// loose equality (the previous approach) handled string<->number but not
	// string<->boolean or string<->array, which made the check fire spuriously
	// every boot for any non-string env var.
	if (parsedArgs && flatConfigObj) {
		let doUpdate = false;
		for (const arg in parsedArgs) {
			const castedValue = castConfigValue(arg, parsedArgs[arg]);
			if (!_.isEqual(castedValue, flatConfigObj[arg.toLowerCase()])) {
				doUpdate = true;
				break;
			}
		}

		if (!doUpdate) {
			logger.trace(`No changes detected in config parameters, skipping update`);
			return;
		}
	}

	if (parsedArgs === undefined && param.toLowerCase() === CONFIG_PARAMS.DATABASES) {
		schemasArgs = value;
	} else if (parsedArgs === undefined) {
		let configParam;
		if (skipParamMap) {
			configParam = param;
		} else {
			configParam = CONFIG_PARAM_MAP[param.toLowerCase()];
			if (configParam === undefined) {
				throw handleHDBError(
					new Error(),
					`Unable to update config, unrecognized config parameter: ${param}`,
					HTTP_STATUS_CODES.BAD_REQUEST,
					undefined,
					undefined,
					true
				);
			}
		}

		const splitParam = configParam.split('_');
		const newValue = castConfigValue(configParam, value);
		configDoc.setIn([...splitParam], newValue);
	} else {
		// Loop through the user inputted args. Match them to a parameter in the default config file and update value.
		for (const arg in parsedArgs) {
			let configParam = CONFIG_PARAM_MAP[arg.toLowerCase()];

			// If setting http.securePort to the same value as http.port, set http.port to null to avoid clashing ports
			if (
				configParam === CONFIG_PARAMS.HTTP_SECUREPORT &&
				parsedArgs[arg] === flatConfigObj[CONFIG_PARAMS.HTTP_PORT]?.toString()
			) {
				configDoc.setIn(['http', 'port'], null);
			}

			// If setting operationsApi.network.securePort to the same value as operationsApi.network.port, set operationsApi.network.port to null to avoid clashing ports
			if (
				configParam === CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT &&
				parsedArgs[arg] === flatConfigObj[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT.toLowerCase()]?.toString()
			) {
				configDoc.setIn(['operationsApi', 'network', 'port'], null);
			}

			// Schemas config args are handled differently, so if they exist set them to var that will be used by setSchemasConfig
			if (configParam === CONFIG_PARAMS.DATABASES) {
				schemasArgs = parsedArgs[arg];
				continue;
			}
			if (configParam?.startsWith('threads_')) {
				// if threads was a number, recreate the threads object
				const threadCount = configDoc.getIn(['threads']) as number;
				if (threadCount >= 0) {
					configDoc.deleteIn(['threads']);
					configDoc.setIn(['threads', 'count'], threadCount);
				}
			}

			if (!configParam && (arg.endsWith('_package') || arg.endsWith('_port'))) {
				configParam = arg;
			}

			if (configParam !== undefined) {
				let splitParam = configParam.split('_');
				const legacyParam = hdbTerms.LEGACY_CONFIG_PARAMS[arg.toUpperCase()];
				if (legacyParam && legacyParam.startsWith('customFunctions') && configDoc.hasIn(legacyParam.split('_'))) {
					configParam = legacyParam;
					splitParam = legacyParam.split('_');
				}

				let newValue = castConfigValue(configParam, parsedArgs[arg]);
				if (configParam === 'rootPath' && newValue?.endsWith('/')) newValue = newValue.slice(0, -1);
				try {
					if (splitParam.length > 1) {
						if (typeof configDoc.getIn(splitParam.slice(0, -1)) === 'boolean') {
							configDoc.deleteIn(splitParam.slice(0, -1));
						}
					}
					configDoc.setIn([...splitParam], newValue);
				} catch (err) {
					logger.error(err);
				}
			}
		}
	}

	if (schemasArgs) setSchemasConfig(configDoc, schemasArgs);

	// Validates config doc and if required sets default values for some parameters.
	validateConfig(configDoc);
	const hdbRoot = configDoc.getIn(['rootPath']) as string;
	let configFileLocation = path.join(hdbRoot, hdbTerms.HARPER_CONFIG_FILE);
	if (!fs.existsSync(configFileLocation) && fs.existsSync(path.join(hdbRoot, hdbTerms.HDB_CONFIG_FILE))) {
		configFileLocation = path.join(hdbRoot, hdbTerms.HDB_CONFIG_FILE);
	}

	if (createBackup === true) {
		// Creates a backup of config before new config is written to disk.
		backupConfigFile(oldConfigPath, hdbRoot);
	}

	if (configDoc.errors?.length > 0) {
		throw handleHDBError(
			new Error(),
			`Error parsing harperdb-config.yaml ${configDoc.errors}`,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR
		);
	}
	atomicWriteFile(configFileLocation, String(configDoc));
	if (update_config_obj) {
		flatConfigObj = flattenConfig(configDoc.toJSON());
	}
	logger.trace(`Config parameter: ${param} updated with value: ${value}`);
}

function backupConfigFile(configPath, hdbRoot) {
	try {
		const backupFolderPath = path.join(
			getBackupDirPath(hdbRoot),
			`${new Date(Date.now()).toISOString().replaceAll(':', '-')}-${hdbTerms.HARPER_CONFIG_FILE}.bak`
		);
		fs.copySync(configPath, backupFolderPath);
		logger.trace(`Config file: ${configPath} backed up to: ${backupFolderPath}`);
	} catch (err) {
		logger.error(BACKUP_ERR);
		logger.error(err);
	}
}

const PRESERVED_PROPERTIES = ['databases'];
/**
 * Flattens the JSON version of Harper config with underscores separating each parent/child key.
 * @param obj
 * @returns {null}
 */
export function flattenConfig(obj) {
	if (obj.http) Object.assign(obj.http, obj?.customFunctions?.network);
	if (obj?.operationsApi?.network) obj.operationsApi.network = { ...obj.http, ...obj.operationsApi.network };
	if (obj?.operationsApi) obj.operationsApi.tls = { ...obj.tls, ...obj.operationsApi.tls };

	configObj = obj;
	const flatObj = squashObj(obj);

	return flatObj;

	function squashObj(obj) {
		let result = {};
		for (let i in obj) {
			if (!obj.hasOwnProperty(i)) continue;

			if (typeof obj[i] == 'object' && obj[i] !== null && !Array.isArray(obj[i]) && !PRESERVED_PROPERTIES.includes(i)) {
				const flatObj = squashObj(obj[i]);
				for (const x in flatObj) {
					if (!flatObj.hasOwnProperty(x)) continue;

					if (x !== 'package') i = i.toLowerCase();
					const key = i + '_' + x;
					// This is here to catch config param which has been renamed/moved
					if (!CONFIG_PARAMS[key.toUpperCase()] && CONFIG_PARAM_MAP[key]) {
						result[CONFIG_PARAM_MAP[key].toLowerCase()] = flatObj[x];
					}

					result[key] = flatObj[x];
				}
			}
			if (obj[i] !== undefined) result[i.toLowerCase()] = obj[i];
		}
		return result;
	}
}

/**
 * Cast config values.
 * @param param
 * @param value
 * @returns {*|number|string|string|null|boolean}
 */
function castConfigValue(param, value) {
	if (isNumber(value)) {
		return parseFloat(value);
	}

	if (value === true || value === false) {
		return value;
	}

	if (Array.isArray(value)) {
		return value;
	}

	if (hdbUtils.isObject(value)) {
		return value;
	}

	if (value === null) {
		return value;
	}

	if (typeof value === 'string' && value.toLowerCase() === 'true') {
		return true;
	}

	if (typeof value === 'string' && value.toLowerCase() === 'false') {
		return false;
	}

	// undefined is not used in our yaml, just null.
	if (value === undefined || value.toLowerCase() === 'undefined') {
		return null;
	}

	//in order to handle json and arrays we test the string to see if it seems minimally like an object or array and perform a JSON.parse on it.
	//if it fails we assume it is just a regular string
	if (
		typeof value === 'string' &&
		((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']')))
	) {
		try {
			return JSON.parse(value);
		} catch {
			//no-op
		}
	}

	return hdbUtils.autoCast(value);
}

/**
 * Get Configuration - this function returns all the config settings
 * @returns {{}}
 */
export function getConfiguration() {
	const bootPropsFilePath = hdbUtils.getPropsFilePath();
	const configFilePath = getConfigFilePath(bootPropsFilePath);
	const configDoc = parseYamlDoc(configFilePath);

	return configDoc.toJSON();
}

/**
 * Set Configuration - this function sets new configuration
 * @param setConfigJson

 */
export async function setConfiguration(setConfigJson) {
	// eslint-disable-next-line no-unused-vars
	const { operation, hdb_user, hdbAuthHeader, replicated, ...configFields } = setConfigJson;
	// Operation-control field, not a config param: enforce boolean (matching other
	// `replicated` surfaces, e.g. analyticsValidator) before any local write so a
	// malformed value like the string "false" — which is truthy — can't apply config
	// locally or trigger an unintended fan-out.
	if (replicated !== undefined && typeof replicated !== 'boolean') {
		throw handleHDBError(
			new Error(),
			`'replicated' must be a boolean`,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
	try {
		updateConfigValue(undefined, undefined, configFields, true);
		if (replicated) {
			// Opt-in fan-out to all cluster nodes (#660). replicateOperation forwards the
			// body with `replicated: false`, so peers apply locally without re-replicating;
			// per-node outcomes are returned on `response.replicated`. `replicated` must
			// stay out of configFields on both origin and peers, or it would be written to
			// the config file as a config param.
			const response = await server.replication.replicateOperation(setConfigJson);
			response.message = CONFIGURE_SUCCESS_RESPONSE;
			return response;
		}
		return CONFIGURE_SUCCESS_RESPONSE;
	} catch (err) {
		if (typeof err === 'string' || err instanceof String) {
			throw handleHDBError(err, err, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
		}
		throw err;
	}
}

export function readConfigFile() {
	const bootPropsFilePath = hdbUtils.getPropsFilePath();
	try {
		fs.accessSync(bootPropsFilePath, fs.constants.F_OK | fs.constants.R_OK);
	} catch (err) {
		if (!hdbUtils.noBootFile()) {
			logger.error(err);
			throw handleHDBError(
				new Error(),
				`Harper properties file at path ${bootPropsFilePath} does not exist`,
				HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR
			);
		}
	}

	const configFilePath = getConfigFilePath(bootPropsFilePath);
	const configDoc = parseYamlDoc(configFilePath);

	return configDoc.toJSON();
}

function parseYamlDoc(filePath) {
	return YAML.parseDocument(fs.readFileSync(filePath, 'utf8'), { simpleKeys: true } as any);
}

/**
 * Apply HARPER_DEFAULT_CONFIG, HARPER_CONFIG and HARPER_SET_CONFIG environment variables at runtime
 *
 * This function performs the following:
 * 1. Loads configuration state to track sources
 * 2. Detects user edits (drift) to protect them from HARPER_DEFAULT_CONFIG
 * 3. Applies HARPER_DEFAULT_CONFIG (respects user edits)
 * 4. Applies HARPER_CONFIG (merge layer: reasserts its keys, yields only to HARPER_SET_CONFIG)
 * 5. Applies HARPER_SET_CONFIG (overrides everything)
 * 6. Handles deletions when keys removed from env vars
 * 7. Saves updated state and persists changes to config file (if configFilePath provided)
 *
 * NOTE: This function performs multiple conversions (YAML → JSON → YAML) which is not
 * efficient but provides clear separation of concerns. The conversions are necessary
 * to handle YAML structure conflicts (e.g., when a boolean like 'threads: true' needs
 * to become an object like 'threads: {count: 4}').
 *
 * @param {Document} configDoc - YAML document to modify (mutated in place)
 * @param {string} [configFilePath] - Path to config file (optional, skips file write if not provided)
 * @param {Object} [options] - Options to pass to applyRuntimeEnvConfig (e.g., {isInstall: true})
 */
function applyRuntimeEnvVarConfig(configDoc, configFilePath, options = {}) {
	const defaultEnvValue = process.env.HARPER_DEFAULT_CONFIG;
	const configEnvValue = process.env.HARPER_CONFIG;
	const setEnvValue = process.env.HARPER_SET_CONFIG;
	const anyEnvValue = defaultEnvValue || configEnvValue || setEnvValue;

	// Get rootPath for state file location
	const rootPath = configDoc.getIn(['rootPath']);
	if (!rootPath) {
		// Only an error if there is config to apply; otherwise there is simply nothing to do.
		if (anyEnvValue) logger.warn('Cannot apply runtime env config: rootPath not found in config');
		return;
	}

	// Skip entirely (zero overhead) only when nothing is set AND there is no prior state to
	// clean up. If a var was applied on a previous boot and then removed, all three env vars
	// are absent now but applyRuntimeEnvConfig must still run to restore originals and clear
	// the snapshot — so don't short-circuit in that case.
	if (!anyEnvValue && !hasPersistedEnvConfigState(rootPath)) return;

	// Convert to JSON for processing
	const configObj = configDoc.toJSON();

	try {
		// Apply env vars with source tracking and drift detection
		applyRuntimeEnvConfig(configObj, rootPath, options);

		// If securePort was set to the same value as port, auto-null port to avoid clashing
		if (configObj.http?.port && configObj.http?.port === configObj.http?.securePort) {
			configObj.http.port = null;
		}
		if (
			configObj.operationsApi?.network?.port &&
			configObj.operationsApi?.network?.port === configObj.operationsApi?.network?.securePort
		) {
			configObj.operationsApi.network.port = null;
		}

		// Update the YAML document's contents
		// We update only the 'contents' property to preserve the Document instance and its methods
		const mergedDoc = YAML.parseDocument(YAML.stringify(configObj), { simpleKeys: true } as any);

		// Check for YAML parsing errors
		if (mergedDoc.errors?.length > 0) {
			throw handleHDBError(
				new Error(),
				`Error parsing harperdb-config.yaml: ${mergedDoc.errors}`,
				HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR
			);
		}

		configDoc.contents = mergedDoc.contents;
	} catch (error) {
		logger.error(`Failed to apply runtime env config: ${error.message}`);
		throw error;
	}

	// We're done here if no config file to write to
	if (!configFilePath) {
		return;
	}

	// Persist changes to file
	try {
		if (configDoc.errors?.length > 0) {
			throw handleHDBError(
				new Error(),
				`Error parsing harperdb-config.yaml: ${configDoc.errors}`,
				HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR
			);
		}
		atomicWriteFile(configFilePath, String(configDoc));
		logger.debug('Config file updated with runtime env var values');
	} catch (error) {
		logger.error(`Failed to write config file after applying runtime env vars: ${error.message}`);
		throw error;
	}
}

/**
 * This function reads config settings from old settings file(before 4.0.0), aligns old keys to new keys, gets old
 * values, and updates the in-memory object.
 * --Located here instead of upgradeUtilities.js to prevent circular dependency--
 * @param oldConfigPath - a string with the old settings path ending in config/settings.js
 */
export function initOldConfig(oldConfigPath: string) {
	const oldHdbProperties = PropertiesReader(oldConfigPath);
	flatConfigObj = {};

	for (const configParam in CONFIG_PARAM_MAP) {
		const value = oldHdbProperties.get(configParam.toUpperCase());
		if (hdbUtils.isEmpty(value) || (typeof value === 'string' && value.trim().length === 0)) {
			continue;
		}
		let paramKey = CONFIG_PARAM_MAP[configParam].toLowerCase();
		if (paramKey === CONFIG_PARAMS.LOGGING_ROOT) {
			flatConfigObj[paramKey] = path.dirname(value as string);
		} else {
			flatConfigObj[paramKey] = value;
		}
	}
	return flatConfigObj;
}

/**
 * Gets a config value directly from harperdb-config.yaml
 * @param param
 * @returns {undefined}
 */
export function getConfigFromFile(param: string) {
	const config_file = readConfigFile();
	return _.get(config_file, param.replaceAll('_', '.'));
}

/**
 * Adds a top level element and any nested values to harperdb-config
 * @param topLevelElement - element name
 * @param values - JSON value which should have top level element
 * @returns {Promise<void>}
 */
export async function addConfig(topLevelElement, values) {
	const configDoc = parseYamlDoc(getConfigFilePath());
	configDoc.hasIn([topLevelElement])
		? configDoc.setIn([topLevelElement], values)
		: configDoc.addIn([topLevelElement], values);
	if (configDoc.errors?.length > 0) {
		throw handleHDBError(
			new Error(),
			`Error parsing harperdb-config.yaml ${configDoc.errors}`,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR
		);
	}
	atomicWriteFile(getConfigFilePath(), String(configDoc));
}

export function deleteConfigFromFile(param: string) {
	const configFilePath = getConfigFilePath(hdbUtils.getPropsFilePath());
	const configDoc = parseYamlDoc(configFilePath);
	configDoc.deleteIn(param);
	const hdbRoot = configDoc.getIn(['rootPath']) as string;
	const configFileLocation = path.join(hdbRoot, hdbTerms.HARPER_CONFIG_FILE);
	atomicWriteFile(configFileLocation, String(configDoc));
}

export function getConfigObj() {
	if (!configObj) {
		initConfig();
		return configObj;
	}

	return configObj;
}

export function getFlatConfigObj() {
	if (!flatConfigObj) initConfig();
	return flatConfigObj;
}
