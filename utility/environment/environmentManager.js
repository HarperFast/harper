'use strict';

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const PropertiesReader = require('properties-reader');
const log = require('../logging/harper_logger');
const common_utils = require('../common_utils');
const hdb_terms = require('../hdbTerms');
const config_utils = require('../../config/configUtils');

const INIT_ERR = 'Error initializing environment manager';
const BOOT_PROPS_FILE_PATH = 'BOOT_PROPS_FILE_PATH';

let prop_file_exists = false;

const install_props_to_save = {
	[hdb_terms.HDB_SETTINGS_NAMES.INSTALL_USER]: true,
	[hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY]: true,
	[hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY]: true,
	BOOT_PROPS_FILE_PATH: true,
};
let install_props = {};
Object.assign(
	exports,
	(module.exports = {
		BOOT_PROPS_FILE_PATH,
		getHdbBasePath,
		setHdbBasePath,
		get,
		initSync,
		setProperty,
		initTestEnvironment,
		setCloneVar,
	})
);

/**
 * The base path of the HDB install is often referenced, but is referenced as a const variable at the top of many
 * modules.  This is a problem during install, as the path may not yet be defined.  We offer a function to get the
 * currently known base path here to help with this case.
 */
function getHdbBasePath() {
	return install_props[hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY];
}

/**
 * Sets the HDB base path in the install props object that this module maintains.
 * This is mainly used by install during a stage where the config file doesn't exist.
 * @param hdb_path
 */
function setHdbBasePath(hdb_path) {
	install_props[hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY] = hdb_path;
}

/**
 * Gets a HarperDB configuration value.
 * @param prop_name
 * @returns {*}
 */
function get(prop_name) {
	const value = config_utils.getConfigValue(prop_name);
	if (value === undefined) {
		return install_props[prop_name];
	}

	return value;
}

/**
 * Will update install props if provided prop is part of that object.
 * Will also update the config object configUtils maintains.
 * Note - this function will NOT update the config file. If you want to update the file
 * use the updateConfigValue method in configUtils.
 *
 * This function should only be used by the installer and unit tests.
 * @param prop_name
 * @param value
 */
function setProperty(prop_name, value) {
	if (install_props_to_save[prop_name]) {
		install_props[prop_name] = value;
	}

	config_utils.updateConfigObject(prop_name, value);
}

/**
 * Checks to see if the HarperDB boot props file exists.
 * If it does, it grabs the install user and settings path for future reference.
 * @returns {boolean}
 */
function doesPropFileExist() {
	let boot_prop_path;
	try {
		boot_prop_path = common_utils.getPropsFilePath();
		fs.accessSync(boot_prop_path, fs.constants.F_OK | fs.constants.R_OK);
		prop_file_exists = true;
		const hdb_props_file = PropertiesReader(boot_prop_path);

		install_props[hdb_terms.HDB_SETTINGS_NAMES.INSTALL_USER] = hdb_props_file.get(
			hdb_terms.HDB_SETTINGS_NAMES.INSTALL_USER
		);
		install_props[hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY] = hdb_props_file.get(
			hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY
		);
		install_props[BOOT_PROPS_FILE_PATH] = boot_prop_path;

		return true;
	} catch (e) {
		log.trace(`Environment manager found no properties file at ${boot_prop_path}`);
		return false;
	}
}

/**
 * Synchronously initializes our config environment.
 * @param force
 */
function initSync(force = false) {
	try {
		// If readPropsFile returns false, we are installing and don't need to read anything yet.
		if (((prop_file_exists || doesPropFileExist() || common_utils.noBootFile()) && !clone_node_running) || force) {
			config_utils.initConfig(force);
			install_props[hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY] = config_utils.getConfigValue(
				hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY
			);
		}
	} catch (err) {
		log.error(INIT_ERR);
		log.error(err);
		console.error(err);
		process.exit(1);
	}
}

let clone_node_running = false;
function setCloneVar(bool) {
	clone_node_running = bool;
}

/**
 * Initializes a test environment.
 * Most of this is legacy code from before the yaml config refactor.
 * @param test_config_obj
 */
function initTestEnvironment(test_config_obj = {}) {
	try {
		const {
			keep_alive_timeout,
			headers_timeout,
			server_timeout,
			https_enabled,
			cors_enabled,
			cors_accesslist,
			local_studio_on,
		} = test_config_obj;
		const props_path = path.join(__dirname, '../../', 'unitTests');
		install_props[BOOT_PROPS_FILE_PATH] = path.join(props_path, 'hdb_boot_properties.file');
		setProperty(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, path.join(props_path, 'settings.test'));
		setProperty(hdb_terms.HDB_SETTINGS_NAMES.INSTALL_USER, os.userInfo() ? os.userInfo().username : undefined);
		setProperty(hdb_terms.HDB_SETTINGS_NAMES.LOG_LEVEL_KEY, `debug`);
		setProperty(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY, path.join(props_path, 'envDir', 'log'));
		setProperty(hdb_terms.HDB_SETTINGS_NAMES.LOG_DAILY_ROTATE_KEY, false);
		setProperty(hdb_terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY, true);
		setProperty(hdb_terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY, '1231412de213');
		setProperty(hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, path.join(props_path, 'envDir'));
		setProperty(hdb_terms.CONFIG_PARAMS.STORAGE_PATH, path.join(props_path, 'envDir'));
		if (https_enabled) {
			setProperty(hdb_terms.CONFIG_PARAMS.HTTP_SECUREPORT, get(hdb_terms.CONFIG_PARAMS.HTTP_PORT));
			setProperty(hdb_terms.CONFIG_PARAMS.HTTP_PORT, null);
		}
		setProperty(hdb_terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_HTTPS, Boolean(https_enabled));
		setProperty(hdb_terms.CONFIG_PARAMS.HTTP_PORT, 9926);
		setProperty(hdb_terms.HDB_SETTINGS_NAMES.SERVER_PORT_KEY, 9925);
		setProperty(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT, 9925);
		setProperty(
			hdb_terms.HDB_SETTINGS_NAMES.CORS_ENABLED_KEY,
			common_utils.isEmpty(cors_enabled) ? false : cors_enabled
		);
		setProperty(hdb_terms.CONFIG_PARAMS.HTTP_CORS, common_utils.isEmpty(cors_enabled) ? false : cors_enabled);
		setProperty(hdb_terms.HDB_SETTINGS_NAMES.MAX_CUSTOM_FUNCTION_PROCESSES, 2);
		setProperty(hdb_terms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES, 4);
		setProperty(hdb_terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_PORT_KEY, 9926);
		setProperty(hdb_terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY, true);
		setProperty(
			hdb_terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY,
			path.resolve(__dirname, '../../unitTests/server/fastifyRoutes/custom_functions')
		);
		setProperty(
			hdb_terms.HDB_SETTINGS_NAMES.LOCAL_STUDIO_ON,
			common_utils.isEmpty(local_studio_on) ? false : local_studio_on
		);
		if (cors_accesslist) {
			setProperty('CORS_ACCESSLIST', cors_accesslist);
			setProperty(hdb_terms.CONFIG_PARAMS.HTTP_CORSACCESSLIST, cors_accesslist);
		}
		if (server_timeout) {
			setProperty(hdb_terms.HDB_SETTINGS_NAMES.SERVER_TIMEOUT_KEY, server_timeout);
			setProperty(hdb_terms.CONFIG_PARAMS.HTTP_TIMEOUT, server_timeout);
		}
		if (keep_alive_timeout) {
			setProperty(hdb_terms.HDB_SETTINGS_NAMES.SERVER_KEEP_ALIVE_TIMEOUT_KEY, keep_alive_timeout);
			setProperty(hdb_terms.CONFIG_PARAMS.HTTP_KEEPALIVETIMEOUT, keep_alive_timeout);
		}
		if (headers_timeout) {
			setProperty(hdb_terms.HDB_SETTINGS_NAMES.SERVER_HEADERS_TIMEOUT_KEY, headers_timeout);
			setProperty(hdb_terms.CONFIG_PARAMS.HTTP_HEADERSTIMEOUT, headers_timeout);
		}
	} catch (err) {
		let msg = `Error reading in HDB environment variables from path ${BOOT_PROPS_FILE_PATH}.  Please check your boot props and settings files`;
		log.fatal(msg);
		log.error(err);
	}
}
