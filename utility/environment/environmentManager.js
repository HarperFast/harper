'use strict';

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const PropertiesReader = require('properties-reader');
const log = require('../logging/harper_logger.js');
const commonUtils = require('../common_utils.js');
const hdbTerms = require('../hdbTerms.ts');
const configUtils = require('../../config/configUtils.js');

const INIT_ERR = 'Error initializing environment manager';
const BOOT_PROPS_FILE_PATH = 'BOOT_PROPS_FILE_PATH';

let propFileExists = false;

const installPropsToSave = {
	[hdbTerms.HDB_SETTINGS_NAMES.INSTALL_USER]: true,
	[hdbTerms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY]: true,
	[hdbTerms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY]: true,
	BOOT_PROPS_FILE_PATH: true,
};
let installProps = {};
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
	})
);

/**
 * The base path of the HDB install is often referenced, but is referenced as a const variable at the top of many
 * modules.  This is a problem during install, as the path may not yet be defined.  We offer a function to get the
 * currently known base path here to help with this case.
 */
function getHdbBasePath() {
	return installProps[hdbTerms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY];
}

/**
 * Sets the HDB base path in the install props object that this module maintains.
 * This is mainly used by install during a stage where the config file doesn't exist.
 * @param hdbPath
 */
function setHdbBasePath(hdbPath) {
	installProps[hdbTerms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY] = hdbPath;
}

/**
 * Gets a HarperDB configuration value.
 * @param propName
 * @returns {*}
 */
function get(propName) {
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
 * This function should only be used by the installer and unit tests.
 * @param propName
 * @param value
 */
function setProperty(propName, value) {
	if (installPropsToSave[propName]) {
		installProps[propName] = value;
	}

	configUtils.updateConfigObject(propName, value);
}

/**
 * Checks to see if the HarperDB boot props file exists.
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

		installProps[hdbTerms.HDB_SETTINGS_NAMES.INSTALL_USER] = hdbPropsFile.get(
			hdbTerms.HDB_SETTINGS_NAMES.INSTALL_USER
		);
		installProps[hdbTerms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY] = hdbPropsFile.get(
			hdbTerms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY
		);
		installProps[BOOT_PROPS_FILE_PATH] = bootPropPath;

		return true;
	} catch (e) {
		log.trace(`Environment manager found no properties file at ${bootPropPath}`);
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
		if (((propFileExists || doesPropFileExist() || commonUtils.noBootFile())) || force) {
			configUtils.initConfig(force);
			installProps[hdbTerms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY] = configUtils.getConfigValue(
				hdbTerms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY
			);
		}
	} catch (err) {
		log.error(INIT_ERR);
		log.error(err);
		console.error(err);
		process.exit(1);
	}
}

/**
 * Initializes a test environment.
 * Most of this is legacy code from before the yaml config refactor.
 * @param testConfigObj
 */
function initTestEnvironment(testConfigObj = {}) {
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
		const propsPath = path.join(__dirname, '../../', 'unitTests');
		installProps[BOOT_PROPS_FILE_PATH] = path.join(propsPath, 'hdb_boot_properties.file');
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, path.join(propsPath, 'settings.test'));
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.INSTALL_USER, os.userInfo() ? os.userInfo().username : undefined);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.LOG_LEVEL_KEY, `debug`);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.LOG_PATH_KEY, path.join(propsPath, 'envDir', 'log'));
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.LOG_DAILY_ROTATE_KEY, false);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY, true);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY, '1231412de213');
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, path.join(propsPath, 'envDir'));
		setProperty(hdbTerms.CONFIG_PARAMS.STORAGE_PATH, path.join(propsPath, 'envDir'));
		if (https_enabled) {
			setProperty(hdbTerms.CONFIG_PARAMS.HTTP_SECUREPORT, get(hdbTerms.CONFIG_PARAMS.HTTP_PORT));
			setProperty(hdbTerms.CONFIG_PARAMS.HTTP_PORT, null);
		}
		setProperty(hdbTerms.CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_HTTPS, Boolean(https_enabled));
		setProperty(hdbTerms.CONFIG_PARAMS.HTTP_PORT, 9926);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.SERVER_PORT_KEY, 9925);
		setProperty(hdbTerms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT, 9925);
		setProperty(
			hdbTerms.HDB_SETTINGS_NAMES.CORS_ENABLED_KEY,
			commonUtils.isEmpty(cors_enabled) ? false : cors_enabled
		);
		setProperty(hdbTerms.CONFIG_PARAMS.HTTP_CORS, commonUtils.isEmpty(cors_enabled) ? false : cors_enabled);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.MAX_CUSTOM_FUNCTION_PROCESSES, 2);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES, 4);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_PORT_KEY, 9926);
		setProperty(hdbTerms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY, true);
		setProperty(
			hdbTerms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY,
			path.resolve(__dirname, '../../unitTests/server/fastifyRoutes/custom_functions')
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
