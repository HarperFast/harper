'use strict';

const hdb_terms = require('../utility/hdbTerms');
const hdb_utils = require('../utility/common_utils');
const logger = require('../utility/logging/harper_logger');
const { configValidator, routesValidator } = require('../validation/configValidator');
const fs = require('fs-extra');
const YAML = require('yaml');
const path = require('path');
const is_number = require('is-number');
const PropertiesReader = require('properties-reader');
const { handleHDBError } = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES, HDB_ERROR_MSGS } = require('../utility/errors/commonErrors');

const UNINIT_GET_CONFIG_ERR = 'Unable to get config value because config is uninitialized';
const CONFIG_INIT_MSG = 'Config successfully initialized';
const BACKUP_ERR = 'Error backing up config file';
const EMPTY_GET_VALUE = 'Empty parameter sent to getConfigValue';
const DEFAULT_CONFIG_FILE_PATH = path.join(__dirname, 'yaml', hdb_terms.HDB_DEFAULT_CONFIG_FILE);
const CONFIGURE_SUCCESS_RESPONSE =
	'Configuration successfully set. You must restart HarperDB for new config settings to take effect.';

let flat_default_config_obj;
let flat_config_obj;

module.exports = {
	createConfigFile,
	getDefaultConfig,
	getConfigValue,
	initConfig,
	flattenConfig,
	updateConfigValue,
	updateConfigObject,
	getConfiguration,
	setConfiguration,
	readConfigFile,
	getClusteringRoutes,
	initOldConfig,
};

/**
 * Builds the HarperDB config file using user inputs and default values from defaultConfig.yaml
 * @param args - any args that the user provided.
 */
function createConfigFile(args) {
	const config_doc = parseYamlDoc(DEFAULT_CONFIG_FILE_PATH);
	flat_default_config_obj = flattenConfig(config_doc.toJSON());

	// Loop through the user inputted args. Match them to a parameter in the default config file and update value.
	for (const arg in args) {
		const config_param = hdb_terms.CONFIG_PARAM_MAP[arg.toLowerCase()];
		if (config_param !== undefined) {
			const split_param = config_param.split('_');
			const value = castConfigValue(config_param, args[arg]);
			try {
				config_doc.setIn([...split_param], value);
			} catch (err) {
				logger.error(err);
			}
		}
	}

	// Validates config doc and if required sets default values for some parameters.
	validateConfig(config_doc);
	const config_obj = config_doc.toJSON();
	flat_config_obj = flattenConfig(config_obj);

	// Create new config file and write config doc to it.
	const hdb_root = config_doc.getIn(['operationsApi', 'root']);
	const config_file_path = path.join(hdb_root, hdb_terms.HDB_CONFIG_FILE);
	fs.createFileSync(config_file_path);
	fs.writeFileSync(config_file_path, String(config_doc));
	logger.trace(`Config file written to ${config_file_path}`);
}

/**
 * Get a default config value from in memory object.
 * If object is undefined read the default config yaml and instantiate default config obj.
 * @param param
 * @returns {*}
 */
function getDefaultConfig(param) {
	if (flat_default_config_obj === undefined) {
		const config_doc = parseYamlDoc(DEFAULT_CONFIG_FILE_PATH);
		flat_default_config_obj = flattenConfig(config_doc.toJSON());
	}

	const param_map = hdb_terms.CONFIG_PARAM_MAP[param.toLowerCase()];
	if (param_map === undefined) return undefined;

	return flat_default_config_obj[param_map.toLowerCase()];
}

/**
 * Get config value from in memory flattened config obj.
 * This functions depends on the config obj being initialized.
 * We do not want it to get value directly from config file as this adds unnecessary overhead.
 * @param param
 * @returns {undefined|*}
 */
function getConfigValue(param) {
	if (hdb_utils.isEmpty(param)) {
		logger.error(EMPTY_GET_VALUE);
		return undefined;
	}

	if (flat_config_obj === undefined) {
		logger.trace(UNINIT_GET_CONFIG_ERR);
		return undefined;
	}

	const param_map = hdb_terms.CONFIG_PARAM_MAP[param.toLowerCase()];
	if (param_map === undefined) return undefined;

	return flat_config_obj[param_map.toLowerCase()];
}

/**
 * If in memory config obj is undefined or init is being forced,
 * read and parses the HarperDB config file and add to config object.
 * @param force
 */
function initConfig(force = false) {
	if (flat_config_obj === undefined || force) {
		const boot_props_file_path = hdb_utils.getPropsFilePath();
		try {
			fs.accessSync(boot_props_file_path, fs.constants.F_OK | fs.constants.R_OK);
		} catch (err) {
			logger.error(err);
			throw new Error(`HarperDB properties file at path ${boot_props_file_path} does not exist`);
		}

		const hdb_properties = PropertiesReader(boot_props_file_path);
		const config_file_path = hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY);
		let config_doc;

		// if this is true, user is upgrading from version prior to 4.0.0. We need to initialize existing
		// params.
		if (config_file_path.includes('config/settings.js')) {
			initOldConfig(config_file_path);
			return;
		}
		try {
			config_doc = parseYamlDoc(config_file_path);
		} catch (err) {
			if (err.code === hdb_terms.NODE_ERROR_CODES.ENOENT) {
				logger.trace(`HarperDB config file not found at ${config_file_path}. 
				This can occur during early stages of install where the config file has not yet been created`);
				return;
			} else {
				logger.error(err);
				throw new Error(`Error reading HarperDB config file at ${config_file_path}`);
			}
		}

		// Validates config doc and if required sets default values for some parameters.
		validateConfig(config_doc);
		const config_obj = config_doc.toJSON();

		flat_config_obj = flattenConfig(config_obj);
		logger.trace(CONFIG_INIT_MSG);
	}
}

/**
 * Validates the config doc and adds any default values to doc.
 * NOTE - If any default values are set in configValidator they also need to be 'setIn' in this function.
 * @param config_doc
 */
function validateConfig(config_doc) {
	const config_json = config_doc.toJSON();
	const validation = configValidator(config_json);
	if (validation.error) {
		throw HDB_ERROR_MSGS.CONFIG_VALIDATION(validation.error.message);
	}

	// These parameters can be set by the validator if they arent provided by user,
	// for this reason we need to update the config yaml doc after the validator has run.
	config_doc.setIn(['customFunctions', 'processes'], validation.value.customFunctions.processes);
	config_doc.setIn(['operationsApi', 'processes'], validation.value.operationsApi.processes);
	config_doc.setIn(['customFunctions', 'root'], validation.value.customFunctions.root);
	config_doc.setIn(['logging', 'root'], validation.value.logging.root);
	config_doc.setIn(['operationsApi', 'tls', 'certificate'], validation.value.operationsApi.tls.certificate);
	config_doc.setIn(['operationsApi', 'tls', 'privateKey'], validation.value.operationsApi.tls.privateKey);
	config_doc.setIn(['customFunctions', 'tls', 'certificate'], validation.value.customFunctions.tls.certificate);
	config_doc.setIn(['customFunctions', 'tls', 'privateKey'], validation.value.customFunctions.tls.privateKey);

	if (!hdb_utils.isEmpty(validation.value?.clustering?.tls?.certificate)) {
		config_doc.setIn(['clustering', 'tls', 'certificate'], validation.value.clustering.tls.certificate);
	}

	if (!hdb_utils.isEmpty(validation.value?.clustering?.tls?.privateKey)) {
		config_doc.setIn(['clustering', 'tls', 'privateKey'], validation.value.clustering.tls.privateKey);
	}

	if (!hdb_utils.isEmpty(validation.value?.clustering?.tls?.certificateAuthority)) {
		config_doc.setIn(
			['clustering', 'tls', 'certificateAuthority'],
			validation.value.clustering.tls.certificateAuthority
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
	if (flat_config_obj === undefined) {
		// This is here to allow unit tests to work when HDB is not installed.
		flat_config_obj = {};
	}

	const config_obj_key = hdb_terms.CONFIG_PARAM_MAP[param.toLowerCase()];
	if (config_obj_key === undefined) {
		logger.trace(`Unable to update config object because config param '${param}' does not exist`);
		return;
	}

	flat_config_obj[config_obj_key.toLowerCase()] = value;
}

/**
 * Updates and validates a config value in config file. Can also create a backup of config before updating.
 * @param param - the config value to update
 * @param value - the value to set the config to
 * @param parsed_args - an object of param/values to update
 * @param create_backup - if true backup file is created
 * @param update_config_obj - if true updates the in memory flattened config object
 */
function updateConfigValue(param, value, parsed_args = undefined, create_backup = false, update_config_obj = false) {
	if (flat_config_obj === undefined) {
		initConfig();
	}

	// Old root/path is used just in case they are updating the operations api root.
	const old_hdb_root = getConfigValue(hdb_terms.CONFIG_PARAM_MAP.hdb_root);
	const old_config_path = path.join(old_hdb_root, hdb_terms.HDB_CONFIG_FILE);
	const config_doc = parseYamlDoc(old_config_path);

	if (parsed_args === undefined) {
		const config_param = hdb_terms.CONFIG_PARAM_MAP[param.toLowerCase()];
		if (config_param === undefined) {
			throw new Error(`Unable to update config, unrecognized config parameter: ${param}`);
		}

		const split_param = config_param.split('_');
		const new_value = castConfigValue(config_param, value);
		config_doc.setIn([...split_param], new_value);
	} else {
		// Loop through the user inputted args. Match them to a parameter in the default config file and update value.
		for (const arg in parsed_args) {
			const config_param = hdb_terms.CONFIG_PARAM_MAP[arg.toLowerCase()];
			if (config_param !== undefined) {
				const split_param = config_param.split('_');
				const new_value = castConfigValue(config_param, parsed_args[arg]);
				try {
					config_doc.setIn([...split_param], new_value);
				} catch (err) {
					logger.error(err);
				}
			}
		}
	}

	// Validates config doc and if required sets default values for some parameters.
	validateConfig(config_doc);
	const hdb_root = config_doc.getIn(['operationsApi', 'root']);
	const config_file_location = path.join(hdb_root, hdb_terms.HDB_CONFIG_FILE);

	// Creates a backup of config before new config is written to disk.
	if (create_backup === true) {
		try {
			const backup_folder_path = path.join(hdb_root, 'backup', `${hdb_terms.HDB_CONFIG_FILE}.bak`);
			fs.copySync(old_config_path, backup_folder_path);
			logger.trace(`Config file: ${old_config_path} backed up to: ${backup_folder_path}`);
		} catch (err) {
			logger.error(BACKUP_ERR);
			logger.error(err);
		}
	}

	fs.writeFileSync(config_file_location, String(config_doc));
	if (update_config_obj) {
		flat_config_obj = flattenConfig(config_doc.toJSON());
	}
	logger.trace(`Config parameter: ${param} updated with value: ${value}`);
}

/**
 * Flattens the JSON version of HarperDB config with underscores separating each parent/child key.
 * @param obj
 * @returns {null}
 */
function flattenConfig(obj) {
	let result = {};

	for (const i in obj) {
		if (!obj.hasOwnProperty(i)) continue;

		if (typeof obj[i] == 'object' && obj[i] !== null && !Array.isArray(obj[i])) {
			const flat_obj = flattenConfig(obj[i]);
			for (const x in flat_obj) {
				if (!flat_obj.hasOwnProperty(x)) continue;

				result[i.toLowerCase() + '_' + x] = flat_obj[x];
			}
		} else {
			result[i.toLowerCase()] = obj[i];
		}
	}
	return result;
}

/**
 * Cast config values.
 * @param param
 * @param value
 * @returns {*|number|string|string|null|boolean}
 */
function castConfigValue(param, value) {
	// Some params should be string numbers if only a number is passed, for those cases we need to cast them to string.
	if (param === hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME || param === hdb_terms.CONFIG_PARAMS.CLUSTERING_USER) {
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
		if (is_number(value)) {
			return parseFloat(value);
		}

		if (value === true || value === false) {
			return value;
		}

		if (Array.isArray(value)) {
			return value;
		}

		if (hdb_utils.isObject(value)) {
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

	return hdb_utils.autoCast(value);
}

/**
 * Get Configuration - this function returns all the config settings
 * @returns {{}}
 */
function getConfiguration() {
	const boot_props_file_path = hdb_utils.getPropsFilePath();
	const hdb_properties = PropertiesReader(boot_props_file_path);
	const config_file_path = hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY);
	const config_doc = parseYamlDoc(config_file_path);

	return config_doc.toJSON();
}

/**
 * Set Configuration - this function sets new configuration
 * @param set_config_json

 */
async function setConfiguration(set_config_json) {
	const { operation, hdb_user, hdb_auth_header, ...config_fields } = set_config_json;
	try {
		updateConfigValue(undefined, undefined, config_fields, true);
		return CONFIGURE_SUCCESS_RESPONSE;
	} catch (err) {
		if (typeof err === 'string' || err instanceof String) {
			throw handleHDBError(err, err, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
		}
		throw err;
	}
}

function readConfigFile() {
	const boot_props_file_path = hdb_utils.getPropsFilePath();
	try {
		fs.accessSync(boot_props_file_path, fs.constants.F_OK | fs.constants.R_OK);
	} catch (err) {
		logger.error(err);
		throw new Error(`HarperDB properties file at path ${boot_props_file_path} does not exist`);
	}

	const hdb_properties = PropertiesReader(boot_props_file_path);
	const config_file_path = hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY);
	const config_doc = parseYamlDoc(config_file_path);

	return config_doc.toJSON();
}

function parseYamlDoc(file_path) {
	return YAML.parseDocument(fs.readFileSync(file_path, 'utf8'), { simpleKeys: true });
}

/**
 * Gets and validates the clustering hub and leaf routes from harperdb conf file.
 * @returns {{leaf_routes: (*[]|any), hub_routes: (*[]|any)}}
 */
function getClusteringRoutes() {
	const json_doc = readConfigFile();
	let hub_routes = json_doc?.clustering?.hubServer?.cluster?.network?.routes;
	hub_routes = hdb_utils.isEmptyOrZeroLength(hub_routes) ? [] : hub_routes;
	const hub_validation = routesValidator(hub_routes);
	if (hub_validation) {
		throw HDB_ERROR_MSGS.CONFIG_VALIDATION(hub_validation.message);
	}

	let leaf_routes = json_doc?.clustering?.leafServer?.network?.routes;
	leaf_routes = hdb_utils.isEmptyOrZeroLength(leaf_routes) ? [] : leaf_routes;
	const leaf_validation = routesValidator(leaf_routes);
	if (leaf_validation) {
		throw HDB_ERROR_MSGS.CONFIG_VALIDATION(leaf_validation.message);
	}

	if (!hdb_utils.isEmptyOrZeroLength(leaf_routes) && !hdb_utils.isEmptyOrZeroLength(hub_routes)) {
		const duplicates = hub_routes.filter((hub_route) =>
			leaf_routes.some((leaf_route) => leaf_route.host === hub_route.host && leaf_route.port === hub_route.port)
		);

		if (!hdb_utils.isEmptyOrZeroLength(duplicates)) {
			const dups_msg = `Duplicate hub and leaf routes found ${JSON.stringify(duplicates)}`;
			throw HDB_ERROR_MSGS.CONFIG_VALIDATION(dups_msg);
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
 * @param old_config_path - a string with the old settings path ending in config/settings.js
 */
function initOldConfig(old_config_path) {
	const old_hdb_properties = PropertiesReader(old_config_path);
	flat_config_obj = {};

	for (const config_param in hdb_terms.CONFIG_PARAM_MAP) {
		const value = old_hdb_properties.get(config_param.toUpperCase());
		const param_key = hdb_terms.CONFIG_PARAM_MAP[config_param].toLowerCase();
		if (!hdb_utils.isEmptyOrZeroLength(value)) {
			flat_config_obj[param_key] = value;
		}
	}
}
