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
const _ = require('lodash');
const { handleHDBError } = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES, HDB_ERROR_MSGS } = require('../utility/errors/commonErrors');
const { server } = require('../server/Server');
const { PACKAGE_ROOT } = require('../utility/packageUtils');

const { DATABASES_PARAM_CONFIG, CONFIG_PARAMS, CONFIG_PARAM_MAP } = hdb_terms;
const UNINIT_GET_CONFIG_ERR = 'Unable to get config value because config is uninitialized';
const CONFIG_INIT_MSG = 'Config successfully initialized';
const BACKUP_ERR = 'Error backing up config file';
const EMPTY_GET_VALUE = 'Empty parameter sent to getConfigValue';
const DEFAULT_CONFIG_FILE_PATH = path.join(PACKAGE_ROOT, 'config', 'yaml', hdb_terms.HDB_DEFAULT_CONFIG_FILE);
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

let flat_default_config_obj;
let flat_config_obj;
let config_obj;

Object.assign(exports, {
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
	getConfigFromFile,
	getConfigFilePath,
	addConfig,
	deleteConfigFromFile,
	getConfigObj,
	resolvePath,
	getFlatConfigObj,
});

function resolvePath(relative_path) {
	if (relative_path?.startsWith('~/')) {
		return path.join(hdb_utils.getHomeDir(), relative_path.slice(1));
	}
	const env = require('../utility/environment/environmentManager');
	try {
		return path.resolve(env.getHdbBasePath(), relative_path);
	} catch(error) {
		console.error('Unable to resolve path', relative_path, error);
		return relative_path;
	}
}

/**
 * Builds the HarperDB config file using user inputs and default values from defaultConfig.yaml
 * @param args - any args that the user provided.
 */
function createConfigFile(args, skip_fs_validation = false) {
	const config_doc = parseYamlDoc(DEFAULT_CONFIG_FILE_PATH);

	// If nats clustering is enabled add the default nats config to harperdb-config
	if (args.clustering_enabled || args.CLUSTERING_ENABLED || args.clustering) {
		const nats_config_doc = YAML.parseDocument(fs.readFileSync(DEFAULT_NATS_CONFIG_FILE_PATH, 'utf8'), {
			simpleKeys: true,
		});
		config_doc.addIn(['clustering'], nats_config_doc.toJSON().clustering);
	}

	flat_default_config_obj = flattenConfig(config_doc.toJSON());

	// Loop through the user inputted args. Match them to a parameter in the default config file and update value.
	let schemas_args;
	for (const arg in args) {
		let config_param = CONFIG_PARAM_MAP[arg.toLowerCase()];

		// Schemas config args are handled differently, so if they exist set them to var that will be used by setSchemasConfig
		if (config_param === CONFIG_PARAMS.DATABASES) {
			if (Array.isArray(args[arg])) {
				schemas_args = args[arg];
			} else {
				schemas_args = Object.keys(args[arg]).map((key) => {
					return { [key]: args[arg][key] };
				});
			}

			continue;
		}

		if (!config_param && (arg.endsWith('_package') || arg.endsWith('_port'))) {
			config_param = arg;
		}

		if (config_param !== undefined) {
			const split_param = config_param.split('_');
			let value = castConfigValue(config_param, args[arg]);
			if (config_param === 'rootPath' && value?.endsWith('/')) value = value.slice(0, -1);
			try {
				config_doc.setIn([...split_param], value);
			} catch (err) {
				logger.error(err);
			}
		}
	}

	if (schemas_args) setSchemasConfig(config_doc, schemas_args);

	// Validates config doc and if required sets default values for some parameters.
	validateConfig(config_doc, skip_fs_validation);
	const config_obj = config_doc.toJSON();
	flat_config_obj = flattenConfig(config_obj);

	// Create new config file and write config doc to it.
	const hdb_root = config_doc.getIn(['rootPath']);
	const config_file_path = path.join(hdb_root, hdb_terms.HDB_CONFIG_FILE);
	fs.createFileSync(config_file_path);
	if (config_doc.errors?.length > 0) throw new Error(`Error parsing harperdb-config.yaml ${config_doc.errors}`);
	fs.writeFileSync(config_file_path, String(config_doc));
	logger.trace(`Config file written to ${config_file_path}`);
}

/**
 * Sets any schema/table location config that belongs under the 'schemas' config element.
 * @param config_doc
 * @param schema_conf_json
 */
function setSchemasConfig(config_doc, schema_conf_json) {
	let schemas_conf;
	try {
		try {
			schemas_conf = JSON.parse(schema_conf_json);
		} catch (err) {
			if (!hdb_utils.isObject(schema_conf_json)) throw err;
			schemas_conf = schema_conf_json;
		}

		for (const schema_conf of schemas_conf) {
			const schema = Object.keys(schema_conf)[0];
			if (schema_conf[schema].hasOwnProperty(DATABASES_PARAM_CONFIG.TABLES)) {
				for (const table in schema_conf[schema][DATABASES_PARAM_CONFIG.TABLES]) {
					// Table path var can be 'path' or 'auditPath'
					for (const table_path_var in schema_conf[schema][DATABASES_PARAM_CONFIG.TABLES][table]) {
						const table_path = schema_conf[schema][DATABASES_PARAM_CONFIG.TABLES][table][table_path_var];
						const keys = [CONFIG_PARAMS.DATABASES, schema, DATABASES_PARAM_CONFIG.TABLES, table, table_path_var];
						config_doc.hasIn(keys) ? config_doc.setIn(keys, table_path) : config_doc.addIn(keys, table_path);
					}
				}
			} else {
				// Schema path var can be 'path' or 'auditPath'
				for (const schema_path_var in schema_conf[schema]) {
					const schema_path = schema_conf[schema][schema_path_var];
					const keys = [CONFIG_PARAMS.DATABASES, schema, schema_path_var];
					config_doc.hasIn(keys) ? config_doc.setIn(keys, schema_path) : config_doc.addIn(keys, schema_path);
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
	if (flat_default_config_obj === undefined) {
		const config_doc = parseYamlDoc(DEFAULT_CONFIG_FILE_PATH);
		flat_default_config_obj = flattenConfig(config_doc.toJSON());
	}

	const param_map = CONFIG_PARAM_MAP[param.toLowerCase()];
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
	if (param == null) {
		logger.info(EMPTY_GET_VALUE);
		return undefined;
	}

	if (flat_config_obj === undefined) {
		logger.trace(UNINIT_GET_CONFIG_ERR);
		return undefined;
	}

	const param_map = CONFIG_PARAM_MAP[param.toLowerCase()];
	if (param_map === undefined) return undefined;

	return flat_config_obj[param_map.toLowerCase()];
}

function getConfigFilePath(boot_props_file_path = hdb_utils.getPropsFilePath()) {
	const cmd_args = hdb_utils.getEnvCliRootPath();
	if (cmd_args) return resolvePath(path.join(cmd_args, hdb_terms.HDB_CONFIG_FILE));
	const hdb_properties = PropertiesReader(boot_props_file_path);
	return resolvePath(hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));
}

/**
 * If in memory config obj is undefined or init is being forced,
 * read and parses the HarperDB config file and add to config object.
 * @param force
 */
function initConfig(force = false) {
	if (flat_config_obj === undefined || force) {
		let boot_props_file_path;
		if (!hdb_utils.noBootFile()) {
			boot_props_file_path = hdb_utils.getPropsFilePath();
			try {
				fs.accessSync(boot_props_file_path, fs.constants.F_OK | fs.constants.R_OK);
			} catch (err) {
				logger.error(err);
				throw new Error(`HarperDB properties file at path ${boot_props_file_path} does not exist`);
			}
		}

		const config_file_path = getConfigFilePath(boot_props_file_path);
		let config_doc;

		// if this is true, user is upgrading from version prior to 4.0.0. We need to initialize existing
		// params.
		if (config_file_path.includes('config/settings.js')) {
			try {
				initOldConfig(config_file_path);
				return;
			} catch (init_err) {
				// If user has an old boot prop file but hdb is not installed init old config will throw ENOENT error.
				// We want to squash that error so that new version of HDB can be installed.
				if (init_err.code !== hdb_terms.NODE_ERROR_CODES.ENOENT) throw init_err;
			}
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

		checkForUpdatedConfig(config_doc, config_file_path);

		// Validates config doc and if required sets default values for some parameters.
		validateConfig(config_doc);
		const config_obj = config_doc.toJSON();
		server.config = config_obj;
		flat_config_obj = flattenConfig(config_obj);

		// If config has old version of logrotate enabled let user know it has been deprecated.
		if (flat_config_obj['logging_rotation_rotate']) {
			for (const key in DEPRECATED_CONFIG) {
				if (flat_config_obj[key])
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
 * @param config_doc
 * @param config_file_path
 */
function checkForUpdatedConfig(config_doc, config_file_path) {
	const root_path = config_doc.getIn(['rootPath']);
	let update_file = false;
	if (!config_doc.hasIn(['storage', 'path'])) {
		config_doc.setIn(['storage', 'path'], path.join(root_path, 'database'));
		update_file = true;
	}

	if (!config_doc.hasIn(['logging', 'rotation', 'path'])) {
		config_doc.setIn(['logging', 'rotation', 'path'], path.join(root_path, 'log'));
		update_file = true;
	}

	if (!config_doc.hasIn(['authentication'])) {
		config_doc.addIn(['authentication'], {
			cacheTTL: 30000,
			enableSessions: true,
			operationTokenTimeout: config_doc.getIn(['operationsApi', 'authentication', 'operationTokenTimeout']) ?? '1d',
			refreshTokenTimeout: config_doc.getIn(['operationsApi', 'authentication', 'refreshTokenTimeout']) ?? '30d',
		});

		update_file = true;
	}

	if (!config_doc.hasIn(['analytics'])) {
		config_doc.addIn(['analytics'], {
			aggregatePeriod: 60,
			replicate: false,
		});

		update_file = true;
	}

	if (update_file) {
		logger.trace('Updating config file with missing config params');
		if (config_doc.errors?.length > 0) throw new Error(`Error parsing harperdb-config.yaml ${config_doc.errors}`);
		fs.writeFileSync(config_file_path, String(config_doc));
	}
}

/**
 * Validates the config doc and adds any default values to doc.
 * NOTE - If any default values are set in configValidator they also need to be 'setIn' in this function.
 * @param config_doc
 */
function validateConfig(config_doc, skip_fs_validation = false) {
	const config_json = config_doc.toJSON();

	// Config might have some legacy values that will be modified by validator. We need to set old to new here before
	// validator sets any defaults
	config_json.componentsRoot = config_json.componentsRoot ?? config_json?.customFunctions?.root;
	if (config_json?.http?.threads) config_json.threads = config_json?.http?.threads;

	if (config_json.http?.port && config_json.http?.port === config_json.http?.securePort) {
		throw HDB_ERROR_MSGS.CONFIG_VALIDATION('http.port and http.securePort cannot be the same value');
	}

	if (
		config_json.operationsApi?.network?.port &&
		config_json.operationsApi?.network?.port === config_json.operationsApi?.network?.securePort
	) {
		throw HDB_ERROR_MSGS.CONFIG_VALIDATION(
			'operationsApi.network.port and operationsApi.network.securePort cannot be the same value'
		);
	}

	const validation = configValidator(config_json, skip_fs_validation);
	if (validation.error) {
		throw HDB_ERROR_MSGS.CONFIG_VALIDATION(validation.error.message);
	}

	// These parameters can be set by the validator if they arent provided by user,
	// for this reason we need to update the config yaml doc after the validator has run.
	if (typeof validation.value.threads === 'object')
		config_doc.setIn(['threads', 'count'], validation.value.threads.count);
	else config_doc.setIn(['threads'], validation.value.threads);
	config_doc.setIn(['componentsRoot'], validation.value.componentsRoot); // TODO: check this works with old config
	config_doc.setIn(['logging', 'root'], validation.value.logging.root);
	config_doc.setIn(['storage', 'path'], validation.value.storage.path);
	config_doc.setIn(['logging', 'rotation', 'path'], validation.value.logging.rotation.path);
	config_doc.setIn(
		['operationsApi', 'network', 'domainSocket'],
		validation.value?.operationsApi?.network?.domainSocket
	);

	if (config_json?.clustering?.enabled) {
		config_doc.setIn(
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
	if (flat_config_obj === undefined) {
		// This is here to allow unit tests to work when HDB is not installed.
		flat_config_obj = {};
	}

	const config_obj_key = CONFIG_PARAM_MAP[param.toLowerCase()];
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
function updateConfigValue(
	param,
	value,
	parsed_args = undefined,
	create_backup = false,
	update_config_obj = false,
	skip_param_map = false
) {
	if (flat_config_obj === undefined) {
		initConfig();
	}

	// Old root/path is used just in case they are updating the operations api root.
	const old_hdb_root = getConfigValue(CONFIG_PARAM_MAP.hdb_root);
	const old_config_path = path.join(old_hdb_root, hdb_terms.HDB_CONFIG_FILE);
	const config_doc = parseYamlDoc(old_config_path);
	let schemas_args;

	// Don't do the update if the values are the same.
	if (parsed_args && flat_config_obj) {
		let doUpdate = false;
		for (const arg in parsed_args) {
			// Using no-strict here because we might need to compare string to number
			if (parsed_args[arg] != flat_config_obj[arg.toLowerCase()]) {
				doUpdate = true;
				break;
			}
		}

		if (!doUpdate) {
			logger.trace(`No changes detected in config parameters, skipping update`);
			return;
		}
	}

	if (parsed_args === undefined && param.toLowerCase() === CONFIG_PARAMS.DATABASES) {
		schemas_args = value;
	} else if (parsed_args === undefined) {
		let config_param;
		if (skip_param_map) {
			config_param = param;
		} else {
			config_param = CONFIG_PARAM_MAP[param.toLowerCase()];
			if (config_param === undefined) {
				throw new Error(`Unable to update config, unrecognized config parameter: ${param}`);
			}
		}

		const split_param = config_param.split('_');
		const new_value = castConfigValue(config_param, value);
		config_doc.setIn([...split_param], new_value);
	} else {
		// Loop through the user inputted args. Match them to a parameter in the default config file and update value.
		for (const arg in parsed_args) {
			let config_param = CONFIG_PARAM_MAP[arg.toLowerCase()];

			// If setting http.securePort to the same value as http.port, set http.port to null to avoid clashing ports
			if (
				config_param === CONFIG_PARAMS.HTTP_SECUREPORT &&
				parsed_args[arg] === flat_config_obj[CONFIG_PARAMS.HTTP_PORT]?.toString()
			) {
				config_doc.setIn(['http', 'port'], null);
			}

			// If setting operationsApi.network.securePort to the same value as operationsApi.network.port, set operationsApi.network.port to null to avoid clashing ports
			if (
				config_param === CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT &&
				parsed_args[arg] === flat_config_obj[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT.toLowerCase()]?.toString()
			) {
				config_doc.setIn(['operationsApi', 'network', 'port'], null);
			}

			// Schemas config args are handled differently, so if they exist set them to var that will be used by setSchemasConfig
			if (config_param === CONFIG_PARAMS.DATABASES) {
				schemas_args = parsed_args[arg];
				continue;
			}
			if (config_param?.startsWith('threads_')) {
				// if threads was a number, recreate the threads object
				const thread_count = config_doc.getIn(['threads']);
				if (thread_count >= 0) {
					config_doc.deleteIn(['threads']);
					config_doc.setIn(['threads', 'count'], thread_count);
				}
			}

			if (!config_param && (arg.endsWith('_package') || arg.endsWith('_port'))) {
				config_param = arg;
			}

			if (config_param !== undefined) {
				let split_param = config_param.split('_');
				const legacy_param = hdb_terms.LEGACY_CONFIG_PARAMS[arg.toUpperCase()];
				if (legacy_param && legacy_param.startsWith('customFunctions') && config_doc.hasIn(legacy_param.split('_'))) {
					config_param = legacy_param;
					split_param = legacy_param.split('_');
				}

				let new_value = castConfigValue(config_param, parsed_args[arg]);
				if (config_param === 'rootPath' && new_value?.endsWith('/')) new_value = new_value.slice(0, -1);
				try {
					if (split_param.length > 1) {
						if (typeof config_doc.getIn(split_param.slice(0, -1)) === 'boolean') {
							config_doc.deleteIn(split_param.slice(0, -1));
						}
					}
					config_doc.setIn([...split_param], new_value);
				} catch (err) {
					logger.error(err);
				}
			}
		}
	}

	if (schemas_args) setSchemasConfig(config_doc, schemas_args);

	// Validates config doc and if required sets default values for some parameters.
	validateConfig(config_doc);
	const hdb_root = config_doc.getIn(['rootPath']);
	const config_file_location = path.join(hdb_root, hdb_terms.HDB_CONFIG_FILE);

	// Creates a backup of config before new config is written to disk.
	if (create_backup === true) {
		backupConfigFile(old_config_path, hdb_root);
	}

	if (config_doc.errors?.length > 0) throw new Error(`Error parsing harperdb-config.yaml ${config_doc.errors}`);
	fs.writeFileSync(config_file_location, String(config_doc));
	if (update_config_obj) {
		flat_config_obj = flattenConfig(config_doc.toJSON());
	}
	logger.trace(`Config parameter: ${param} updated with value: ${value}`);
}

function backupConfigFile(config_path, hdb_root) {
	try {
		const backup_folder_path = path.join(
			hdb_root,
			'backup',
			`${new Date(Date.now()).toISOString().replaceAll(':', '-')}-${hdb_terms.HDB_CONFIG_FILE}.bak`
		);
		fs.copySync(config_path, backup_folder_path);
		logger.trace(`Config file: ${config_path} backed up to: ${backup_folder_path}`);
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

	config_obj = obj;
	const flat_obj = squashObj(obj);

	return flat_obj;

	function squashObj(obj) {
		let result = {};
		for (let i in obj) {
			if (!obj.hasOwnProperty(i)) continue;

			if (typeof obj[i] == 'object' && obj[i] !== null && !Array.isArray(obj[i]) && !PRESERVED_PROPERTIES.includes(i)) {
				const flat_obj = squashObj(obj[i]);
				for (const x in flat_obj) {
					if (!flat_obj.hasOwnProperty(x)) continue;

					if (x !== 'package') i = i.toLowerCase();
					const key = i + '_' + x;
					// This is here to catch config param which has been renamed/moved
					if (!CONFIG_PARAMS[key.toUpperCase()] && CONFIG_PARAM_MAP[key]) {
						result[CONFIG_PARAM_MAP[key].toLowerCase()] = flat_obj[x];
					}

					result[key] = flat_obj[x];
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

	return hdb_utils.autoCast(value);
}

/**
 * Get Configuration - this function returns all the config settings
 * @returns {{}}
 */
function getConfiguration() {
	const boot_props_file_path = hdb_utils.getPropsFilePath();
	const config_file_path = getConfigFilePath(boot_props_file_path);
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
		if (!hdb_utils.noBootFile()) {
			logger.error(err);
			throw new Error(`HarperDB properties file at path ${boot_props_file_path} does not exist`);
		}
	}

	const config_file_path = getConfigFilePath(boot_props_file_path);
	const config_doc = parseYamlDoc(config_file_path);

	return config_doc.toJSON();
}

function parseYamlDoc(file_path) {
	return YAML.parseDocument(fs.readFileSync(file_path, 'utf8'), { simpleKeys: true });
}

/**
 * Gets and validates the clustering hub and leaf routes from harperdb-config file.
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

	for (const config_param in CONFIG_PARAM_MAP) {
		const value = old_hdb_properties.get(config_param.toUpperCase());
		if (hdb_utils.isEmpty(value) || (typeof value === 'string' && value.trim().length === 0)) {
			continue;
		}
		let param_key = CONFIG_PARAM_MAP[config_param].toLowerCase();
		if (param_key === CONFIG_PARAMS.LOGGING_ROOT) {
			flat_config_obj[param_key] = path.dirname(value);
		} else {
			flat_config_obj[param_key] = value;
		}
	}
	return flat_config_obj;
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
 * @param top_level_element - element name
 * @param values - JSON value which should have top level element
 * @returns {Promise<void>}
 */
async function addConfig(top_level_element, values) {
	const config_doc = parseYamlDoc(getConfigFilePath());
	config_doc.hasIn([top_level_element])
		? config_doc.setIn([top_level_element], values)
		: config_doc.addIn([top_level_element], values);
	if (config_doc.errors?.length > 0) throw new Error(`Error parsing harperdb-config.yaml ${config_doc.errors}`);
	await fs.writeFile(getConfigFilePath(), String(config_doc));
}

function deleteConfigFromFile(param) {
	const config_file_path = getConfigFilePath(hdb_utils.getPropsFilePath());
	const config_doc = parseYamlDoc(config_file_path);
	config_doc.deleteIn(param);
	const hdb_root = config_doc.getIn(['rootPath']);
	const config_file_location = path.join(hdb_root, hdb_terms.HDB_CONFIG_FILE);
	fs.writeFileSync(config_file_location, String(config_doc));
}

function getConfigObj() {
	if (!config_obj) {
		initConfig();
		return config_obj;
	}

	return config_obj;
}

function getFlatConfigObj() {
	if (!flat_config_obj) initConfig();
	return flat_config_obj;
}
