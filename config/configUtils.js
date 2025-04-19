'use strict';

const hdbTerms = require('../utility/hdbTerms.ts');
const hdbUtils = require('../utility/common_utils.js');
const logger = require('../utility/logging/harper_logger.js');
const { configValidator, routesValidator } = require('../validation/configValidator.js');
const fs = require('fs-extra');
const YAML = require('yaml');
const path = require('path');
const isNumber = require('is-number');
const PropertiesReader = require('properties-reader');
const _ = require('lodash');
const { handleHDBError } = require('../utility/errors/hdbError.js');
const { HTTP_STATUS_CODES, HDB_ERROR_MSGS } = require('../utility/errors/commonErrors.js');
const { server } = require('../server/Server.ts');
const { PACKAGE_ROOT } = require('../utility/packageUtils.js');

const { DATABASES_PARAM_CONFIG, CONFIG_PARAMS, CONFIG_PARAM_MAP } = hdbTerms;
const UNINIT_GET_CONFIG_ERR = 'Unable to get config value because config is uninitialized';
const CONFIG_INIT_MSG = 'Config successfully initialized';
const BACKUP_ERR = 'Error backing up config file';
const EMPTY_GET_VALUE = 'Empty parameter sent to getConfigValue';
const DEFAULT_CONFIG_FILE_PATH = path.join(PACKAGE_ROOT, 'config', 'yaml', hdbTerms.HDB_DEFAULT_CONFIG_FILE);
const DEFAULT_NATS_CONFIG_FILE_PATH = path.join(PACKAGE_ROOT, 'config', 'yaml', 'defaultNatsConfig.yaml');
const CONFIGURE_SUCCESS_RESPONSE =
	'Configuration successfully set. You must restart HarperDB for new config settings to take effect.';

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

exports.createConfigFile = createConfigFile;
exports.getDefaultConfig = getDefaultConfig;
exports.getConfigValue = getConfigValue;
exports.initConfig = initConfig;
exports.flattenConfig = flattenConfig;
exports.updateConfigValue = updateConfigValue;
exports.updateConfigObject = updateConfigObject;
exports.getConfiguration = getConfiguration;
exports.setConfiguration = setConfiguration;
exports.readConfigFile = readConfigFile;
exports.getClusteringRoutes = getClusteringRoutes;
exports.initOldConfig = initOldConfig;
exports.getConfigFromFile = getConfigFromFile;
exports.getConfigFilePath = getConfigFilePath;
exports.addConfig = addConfig;
exports.deleteConfigFromFile = deleteConfigFromFile;
exports.getConfigObj = getConfigObj;
exports.resolvePath = resolvePath;
exports.getFlatConfigObj = getFlatConfigObj;


function resolvePath(relativePath) {
	if (relativePath?.startsWith('~/')) {
		return path.join(hdbUtils.getHomeDir(), relativePath.slice(1));
	}
	const env = require('../utility/environment/environmentManager.js');
	try {
		return path.resolve(env.getHdbBasePath(), relativePath);
	} catch(error) {
		console.error('Unable to resolve path', relativePath, error);
		return relativePath;
	}
}

/**
 * Builds the HarperDB config file using user inputs and default values from defaultConfig.yaml
 * @param args - any args that the user provided.
 */
function createConfigFile(args, skipFsValidation = false) {
	const configDoc = parseYamlDoc(DEFAULT_CONFIG_FILE_PATH);

	// If nats clustering is enabled add the default nats config to harperdb-config
	if (args.clustering_enabled || args.CLUSTERING_ENABLED || args.clustering) {
		const natsConfigDoc = YAML.parseDocument(fs.readFileSync(DEFAULT_NATS_CONFIG_FILE_PATH, 'utf8'), {
			simpleKeys: true,
		});
		configDoc.addIn(['clustering'], natsConfigDoc.toJSON().clustering);
	}

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
				configDoc.setIn([...splitParam], value);
			} catch (err) {
				logger.error(err);
			}
		}
	}

	if (schemasArgs) setSchemasConfig(configDoc, schemasArgs);

	// Validates config doc and if required sets default values for some parameters.
	validateConfig(configDoc, skipFsValidation);
	const configObj = configDoc.toJSON();
	flatConfigObj = flattenConfig(configObj);

	// Create new config file and write config doc to it.
	const hdbRoot = configDoc.getIn(['rootPath']);
	const configFilePath = path.join(hdbRoot, hdbTerms.HDB_CONFIG_FILE);
	fs.createFileSync(configFilePath);
	if (configDoc.errors?.length > 0) throw new Error(`Error parsing harperdb-config.yaml ${configDoc.errors}`);
	fs.writeFileSync(configFilePath, String(configDoc));
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
function getDefaultConfig(param) {
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
function getConfigValue(param) {
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

function getConfigFilePath(bootPropsFilePath = hdbUtils.getPropsFilePath()) {
	const cmdArgs = hdbUtils.getEnvCliRootPath();
	if (cmdArgs) return resolvePath(path.join(cmdArgs, hdbTerms.HDB_CONFIG_FILE));
	const hdbProperties = PropertiesReader(bootPropsFilePath);
	return resolvePath(hdbProperties.get(hdbTerms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));
}

/**
 * If in memory config obj is undefined or init is being forced,
 * read and parses the HarperDB config file and add to config object.
 * @param force
 */
function initConfig(force = false) {
	if (flatConfigObj === undefined || force) {
		let bootPropsFilePath;
		if (!hdbUtils.noBootFile()) {
			bootPropsFilePath = hdbUtils.getPropsFilePath();
			try {
				fs.accessSync(bootPropsFilePath, fs.constants.F_OK | fs.constants.R_OK);
			} catch (err) {
				logger.error(err);
				throw new Error(`HarperDB properties file at path ${bootPropsFilePath} does not exist`);
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
				logger.trace(`HarperDB config file not found at ${configFilePath}. 
				This can occur during early stages of install where the config file has not yet been created`);
				return;
			} else {
				logger.error(err);
				throw new Error(`Error reading HarperDB config file at ${configFilePath}`);
			}
		}

		checkForUpdatedConfig(configDoc, configFilePath);

		// Validates config doc and if required sets default values for some parameters.
		validateConfig(configDoc);
		const configObj = configDoc.toJSON();
		server.config = configObj;
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
	const rootPath = configDoc.getIn(['rootPath']);
	let updateFile = false;
	if (!configDoc.hasIn(['storage', 'path'])) {
		configDoc.setIn(['storage', 'path'], path.join(rootPath, 'database'));
		updateFile = true;
	}

	if (!configDoc.hasIn(['logging', 'rotation', 'path'])) {
		configDoc.setIn(['logging', 'rotation', 'path'], path.join(rootPath, 'log'));
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
		if (configDoc.errors?.length > 0) throw new Error(`Error parsing harperdb-config.yaml ${configDoc.errors}`);
		fs.writeFileSync(configFilePath, String(configDoc));
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
		throw HDB_ERROR_MSGS.CONFIG_VALIDATION('http.port and http.securePort cannot be the same value');
	}

	if (
		configJson.operationsApi?.network?.port &&
		configJson.operationsApi?.network?.port === configJson.operationsApi?.network?.securePort
	) {
		throw HDB_ERROR_MSGS.CONFIG_VALIDATION(
			'operationsApi.network.port and operationsApi.network.securePort cannot be the same value'
		);
	}

	const validation = configValidator(configJson, skipFsValidation);
	if (validation.error) {
		throw HDB_ERROR_MSGS.CONFIG_VALIDATION(validation.error.message);
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
	configDoc.setIn(
		['operationsApi', 'network', 'domainSocket'],
		validation.value?.operationsApi?.network?.domainSocket
	);

	if (configJson?.clustering?.enabled) {
		configDoc.setIn(
			['clustering', 'leafServer', 'streams', 'path'],
			validation.value.clustering.leafServer.streams?.path
		);
	}
}

/**
 * Updates the in memory flattened config object. Does not update the config file.
 * This is mainly here to accommodate older versions of environmentManager and unit tests.
 * @param param
 * @param value
 */
function updateConfigObject(param, value) {
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
function updateConfigValue(
	param,
	value,
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
	const oldConfigPath = path.join(oldHdbRoot, hdbTerms.HDB_CONFIG_FILE);
	const configDoc = parseYamlDoc(oldConfigPath);
	let schemasArgs;

	// Don't do the update if the values are the same.
	if (parsedArgs && flatConfigObj) {
		let doUpdate = false;
		for (const arg in parsedArgs) {
			// Using no-strict here because we might need to compare string to number
			if (parsedArgs[arg] != flatConfigObj[arg.toLowerCase()]) {
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
				throw new Error(`Unable to update config, unrecognized config parameter: ${param}`);
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
				const threadCount = configDoc.getIn(['threads']);
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
	const hdbRoot = configDoc.getIn(['rootPath']);
	const configFileLocation = path.join(hdbRoot, hdbTerms.HDB_CONFIG_FILE);

	// Creates a backup of config before new config is written to disk.
	if (createBackup === true) {
		backupConfigFile(oldConfigPath, hdbRoot);
	}

	if (configDoc.errors?.length > 0) throw new Error(`Error parsing harperdb-config.yaml ${configDoc.errors}`);
	fs.writeFileSync(configFileLocation, String(configDoc));
	if (update_config_obj) {
		flatConfigObj = flattenConfig(configDoc.toJSON());
	}
	logger.trace(`Config parameter: ${param} updated with value: ${value}`);
}

function backupConfigFile(configPath, hdbRoot) {
	try {
		const backupFolderPath = path.join(
			hdbRoot,
			'backup',
			`${new Date(Date.now()).toISOString().replaceAll(':', '-')}-${hdbTerms.HDB_CONFIG_FILE}.bak`
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
 * Flattens the JSON version of HarperDB config with underscores separating each parent/child key.
 * @param obj
 * @returns {null}
 */
function flattenConfig(obj) {
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
	// Some params should be string numbers if only a number is passed, for those cases we need to cast them to string.
	if (param === CONFIG_PARAMS.CLUSTERING_NODENAME || param === CONFIG_PARAMS.CLUSTERING_USER) {
		if (value == null) return value;
		if (!isNaN(value)) {
			return value.toString();
		}

		if (
			(typeof value === 'string' && value.toLowerCase() === 'true') ||
			(typeof value === 'string' && value.toLowerCase() === 'false')
		) {
			return value;
		}
	} else {
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
		} catch (e) {
			//no-op
		}
	}

	return hdbUtils.autoCast(value);
}

/**
 * Get Configuration - this function returns all the config settings
 * @returns {{}}
 */
function getConfiguration() {
	const bootPropsFilePath = hdbUtils.getPropsFilePath();
	const configFilePath = getConfigFilePath(bootPropsFilePath);
	const configDoc = parseYamlDoc(configFilePath);

	return configDoc.toJSON();
}

/**
 * Set Configuration - this function sets new configuration
 * @param setConfigJson

 */
async function setConfiguration(setConfigJson) {
	const { operation, hdb_user, hdbAuthHeader, ...configFields } = setConfigJson;
	try {
		updateConfigValue(undefined, undefined, configFields, true);
		return CONFIGURE_SUCCESS_RESPONSE;
	} catch (err) {
		if (typeof err === 'string' || err instanceof String) {
			throw handleHDBError(err, err, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
		}
		throw err;
	}
}

function readConfigFile() {
	const bootPropsFilePath = hdbUtils.getPropsFilePath();
	try {
		fs.accessSync(bootPropsFilePath, fs.constants.F_OK | fs.constants.R_OK);
	} catch (err) {
		if (!hdbUtils.noBootFile()) {
			logger.error(err);
			throw new Error(`HarperDB properties file at path ${bootPropsFilePath} does not exist`);
		}
	}

	const configFilePath = getConfigFilePath(bootPropsFilePath);
	const configDoc = parseYamlDoc(configFilePath);

	return configDoc.toJSON();
}

function parseYamlDoc(filePath) {
	return YAML.parseDocument(fs.readFileSync(filePath, 'utf8'), { simpleKeys: true });
}

/**
 * Gets and validates the clustering hub and leaf routes from harperdb-config file.
 * @returns {{leaf_routes: (*[]|any), hub_routes: (*[]|any)}}
 */
function getClusteringRoutes() {
	const jsonDoc = readConfigFile();
	let hub_routes = jsonDoc?.clustering?.hubServer?.cluster?.network?.routes;
	hub_routes = hdbUtils.isEmptyOrZeroLength(hub_routes) ? [] : hub_routes;
	const hubValidation = routesValidator(hub_routes);
	if (hubValidation) {
		throw HDB_ERROR_MSGS.CONFIG_VALIDATION(hubValidation.message);
	}

	let leaf_routes = jsonDoc?.clustering?.leafServer?.network?.routes;
	leaf_routes = hdbUtils.isEmptyOrZeroLength(leaf_routes) ? [] : leaf_routes;
	const leafValidation = routesValidator(leaf_routes);
	if (leafValidation) {
		throw HDB_ERROR_MSGS.CONFIG_VALIDATION(leafValidation.message);
	}

	if (!hdbUtils.isEmptyOrZeroLength(leaf_routes) && !hdbUtils.isEmptyOrZeroLength(hub_routes)) {
		const duplicates = hub_routes.filter((hubRoute) =>
			leaf_routes.some((leafRoute) => leafRoute.host === hubRoute.host && leafRoute.port === hubRoute.port)
		);

		if (!hdbUtils.isEmptyOrZeroLength(duplicates)) {
			const dupsMsg = `Duplicate hub and leaf routes found ${JSON.stringify(duplicates)}`;
			throw HDB_ERROR_MSGS.CONFIG_VALIDATION(dupsMsg);
		}
	}

	return {
		hub_routes,
		leaf_routes,
	};
}

/**
 * This function reads config settings from old settings file(before 4.0.0), aligns old keys to new keys, gets old
 * values, and updates the in-memory object.
 * --Located here instead of upgradeUtilities.js to prevent circular dependency--
 * @param oldConfigPath - a string with the old settings path ending in config/settings.js
 */
function initOldConfig(oldConfigPath) {
	const oldHdbProperties = PropertiesReader(oldConfigPath);
	flatConfigObj = {};

	for (const configParam in CONFIG_PARAM_MAP) {
		const value = oldHdbProperties.get(configParam.toUpperCase());
		if (hdbUtils.isEmpty(value) || (typeof value === 'string' && value.trim().length === 0)) {
			continue;
		}
		let paramKey = CONFIG_PARAM_MAP[configParam].toLowerCase();
		if (paramKey === CONFIG_PARAMS.LOGGING_ROOT) {
			flatConfigObj[paramKey] = path.dirname(value);
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
function getConfigFromFile(param) {
	const config_file = readConfigFile();
	return _.get(config_file, param.replaceAll('_', '.'));
}

/**
 * Adds a top level element and any nested values to harperdb-config
 * @param topLevelElement - element name
 * @param values - JSON value which should have top level element
 * @returns {Promise<void>}
 */
async function addConfig(topLevelElement, values) {
	const configDoc = parseYamlDoc(getConfigFilePath());
	configDoc.hasIn([topLevelElement])
		? configDoc.setIn([topLevelElement], values)
		: configDoc.addIn([topLevelElement], values);
	if (configDoc.errors?.length > 0) throw new Error(`Error parsing harperdb-config.yaml ${configDoc.errors}`);
	await fs.writeFile(getConfigFilePath(), String(configDoc));
}

function deleteConfigFromFile(param) {
	const configFilePath = getConfigFilePath(hdbUtils.getPropsFilePath());
	const configDoc = parseYamlDoc(configFilePath);
	configDoc.deleteIn(param);
	const hdbRoot = configDoc.getIn(['rootPath']);
	const configFileLocation = path.join(hdbRoot, hdbTerms.HDB_CONFIG_FILE);
	fs.writeFileSync(configFileLocation, String(configDoc));
}

function getConfigObj() {
	if (!configObj) {
		initConfig();
		return configObj;
	}

	return configObj;
}

function getFlatConfigObj() {
	if (!flatConfigObj) initConfig();
	return flatConfigObj;
}
