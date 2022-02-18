'use strict';

const hdb_terms = require('../utility/hdbTerms');
const hdb_utils = require('../utility/common_utils');
const logger = require('../utility/logging/harper_logger');
const config_validator = require('../validation/configValidator');
const fs = require('fs-extra');
const YAML = require('yaml');
const path = require('path');
const PropertiesReader = require('properties-reader');
const env = require('../utility/environment/environmentManager');

const UNINIT_GET_CONFIG_ERR = 'Unable to get config value because config is uninitialized';
const CONFIG_INIT_MSG = 'Config successfully initialized';
const BACKUP_ERR = 'Error backing up config file';
const EMPTY_GET_VALUE = 'Empty parameter sent to getConfigValue';
const DEFAULT_CONFIG_FILE_PATH = path.join(__dirname, 'yaml', hdb_terms.HDB_DEFAULT_CONFIG_FILE);
const CONFIGURE_SUCCESS_RESPONSE =
	'Successfully configured and loaded clustering configuration.  Some configurations may require a restart of HarperDB to take effect.';

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
};

/**
 * Builds the HarperDB config file using user inputs and default values from defaultConfig.yaml
 * @param args - any args that the user provided.
 */
function createConfigFile(args) {
	const config_doc = YAML.parseDocument(fs.readFileSync(DEFAULT_CONFIG_FILE_PATH, 'utf8'));
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
		const config_doc = YAML.parseDocument(fs.readFileSync(DEFAULT_CONFIG_FILE_PATH, 'utf8'));
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
		try {
			config_doc = YAML.parseDocument(fs.readFileSync(config_file_path, 'utf8'));
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
	const validation = config_validator(config_json);
	if (validation.error) {
		throw `HarperDB config file validation error: ${validation.error.message}`;
	}

	// These parameters can be set by the validator if they arent provided by user,
	// for this reason we need to update the config yaml doc after the validator has run.
	config_doc.setIn(['customFunctions', 'processes'], validation.value.customFunctions.processes);
	config_doc.setIn(['operationsApi', 'processes'], validation.value.operationsApi.processes);
	config_doc.setIn(['customFunctions', 'root'], validation.value.customFunctions.root);
	config_doc.setIn(['logging', 'root'], validation.value.logging.root);
	config_doc.setIn(['operationsApi', 'network', 'certificate'], validation.value.operationsApi.network.certificate);
	config_doc.setIn(['operationsApi', 'network', 'privateKey'], validation.value.operationsApi.network.privateKey);
	config_doc.setIn(['customFunctions', 'network', 'certificate'], validation.value.customFunctions.network.certificate);
	config_doc.setIn(['customFunctions', 'network', 'privateKey'], validation.value.customFunctions.network.privateKey);
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
 * @param parsed_args - an array of param/values to update
 * @param create_backup - if true backup file is created
 */
function updateConfigValue(param, value, parsed_args = undefined, create_backup = false) {
	if (flat_config_obj === undefined) {
		initConfig();
	}

	// Old root/path is used just in case they are updating the operations api root.
	const old_hdb_root = getConfigValue(hdb_terms.CONFIG_PARAM_MAP.hdb_root);
	const old_config_path = path.join(old_hdb_root, hdb_terms.HDB_CONFIG_FILE);
	const config_doc = YAML.parseDocument(fs.readFileSync(old_config_path, 'utf8'));

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
	flat_config_obj = flattenConfig(config_doc.toJSON());
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
		if (value === true || value === false) {
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
	if (value.toLowerCase() === 'undefined' || value.toLowerCase() === undefined) {
		return null;
	}

	return hdb_utils.autoCast(value);
}

/**
 * this function returns all of the config settings
 * @returns {{}}
 */
function getConfiguration() {
	const config_doc = YAML.parseDocument(
		fs.readFileSync(path.join(env.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_ROOT), hdb_terms.HDB_CONFIG_FILE), 'utf8')
	);

	return config_doc.toJSON();
}

/**
 * Configure clustering by updating the config settings file with the specified parameters in the message, and then
 * start or stop clustering depending on the enabled value.
 * @param enable_cluster_json
 * @returns {Promise<void>}
 */
async function setConfiguration(enable_cluster_json) {
	logger.debug('In setConfiguration');
	let { operation, hdb_user, hdb_auth_header, ...config_fields } = enable_cluster_json;

	// We need to make all fields upper case so they will match in the validator.  It is less efficient to do this in its
	// own loop, but we dont want to update the file unless all fields pass validation, and we can't validate until all
	// fields are converted.
	let field_keys = Object.keys(config_fields);
	for (let i = 0; i < field_keys.length; ++i) {
		let orig_field_name = field_keys[i];

		// if the field is not all uppercase in the config_fields object, then add the all uppercase field
		// and remove the old not uppercase field.
		if (config_fields[orig_field_name.toUpperCase()] === undefined) {
			config_fields[orig_field_name.toUpperCase()] = config_fields[orig_field_name];
			delete config_fields[orig_field_name];
		}

		// if the field is not all uppercase in the config_fields object, then add the all uppercase field
		// and remove the old not uppercase field.
		if (enable_cluster_json[orig_field_name.toUpperCase()] === undefined) {
			enable_cluster_json[orig_field_name.toUpperCase()] = enable_cluster_json[orig_field_name];
			delete enable_cluster_json[orig_field_name];
		}
	}

	if (config_fields.NODE_NAME !== undefined) {
		config_fields.NODE_NAME = config_fields.NODE_NAME.toString();
	}

	// TODO - this full function will be refactored as part of config upgrade epic
	// let validation = await configure_validator(config_fields);
	// if (validation) {
	// 	log.error(`Validation error in setConfiguration validation. ${validation}`);
	// 	throw new Error(validation);
	// }

	try {
		let msg_keys = Object.keys(config_fields);
		for (let i = 0; i < msg_keys.length; ++i) {
			let curr = msg_keys[i];

			if (curr) {
				logger.info(`Setting property ${curr} to value ${enable_cluster_json[curr]}`);
				updateConfigValue(curr, enable_cluster_json[curr], undefined, true);
				logger.info('Completed writing new settings to file and reloading the manager.');
			}
		}

		return CONFIGURE_SUCCESS_RESPONSE;
	} catch (err) {
		logger.error(err);
		throw 'There was an error storing the configuration information.  Please check the logs and try again.';
	}
}
