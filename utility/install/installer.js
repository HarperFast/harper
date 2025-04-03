'use strict';

const os = require('os');
const inquirer = require('inquirer');
const fs = require('fs-extra');
const PropertiesReader = require('properties-reader');
const chalk = require('chalk');
const path = require('path');
const hri = require('human-readable-ids').hri;
const ora = require('ora');
const YAML = require('yaml');

const hdb_logger = require('../logging/harper_logger');
const env_manager = require('../environment/environmentManager');
const hdb_utils = require('../common_utils');
const assignCMDENVVariables = require('../../utility/assignCmdEnvVariables');
const hdb_info_controller = require('../../dataLayer/hdbInfoController');
const { packageJson } = require('../packageUtils');
const hdb_terms = require('../hdbTerms');
const { CONFIG_PARAM_MAP, CONFIG_PARAMS } = hdb_terms;
const install_validator = require('../../validation/installValidator');
const mount_hdb = require('../mount_hdb');
const config_utils = require('../../config/configUtils');
const user_ops = require('../../security/user');
const role_ops = require('../../security/role');
const check_jwt_tokens = require('./checkJWTTokensExist');
const global_schema = require('../globalSchema');
const promisify = require('util').promisify;
const p_schema_to_global = promisify(global_schema.setSchemaDataToGlobal);
const keys = require('../../security/keys');

// Removes the color formatting that was being applied to the prompt answer.
const PROMPT_ANSWER_TRANSFORMER = (answer) => answer;
const HDB_PROMPT_MSG = (msg) => chalk.magenta.bold(msg);
const TERMS_ADDRESS = 'https://harperdb.io/legal/end-user-license-agreement';
const LINE_BREAK = os.EOL;
const PROMPT_PREFIX = '';
const ACCEPTABLE_TC_RESPONSE = 'yes';
const INSTALL_START_MSG = 'Starting HarperDB install...';
const INSTALL_COMPLETE_MSG = 'HarperDB installation was successful.';
const TC_NOT_ACCEPTED = 'Terms & Conditions acceptance is required to proceed with installation. Exiting install...';
const UPGRADE_MSG = 'An out of date version of HarperDB is already installed.';
const HDB_EXISTS_MSG = 'It appears that HarperDB is already installed. Exiting install...';
const ABORT_MSG = 'Aborting install';
const HDB_PORT_REGEX = new RegExp(
	/^([0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/
);
const KEY_PAIR_BITS = 2048;
const NODE_NAME_REGEX = new RegExp(/^[^\s.,*>]+$/);
const PROCESS_HOME = os.homedir();
const DEFAULT_HDB_ROOT = path.join(PROCESS_HOME, hdb_terms.HDB_ROOT_DIR_NAME);
const DEFAULT_HDB_PORT = 9925;
const DEFAULT_ADMIN_USERNAME = 'HDB_ADMIN';
const DEFAULT_CLUSTER_USERNAME = 'CLUSTER_USER';
const DEFAULT_CONFIG_MODE = 'dev';
const DEFAULT_HOST_NAME = 'localhost';

const DEV_MODE_CONFIG = {
	[CONFIG_PARAMS.HTTP_CORS]: true,
	[CONFIG_PARAMS.HTTP_CORSACCESSLIST]: ['*'],
	[CONFIG_PARAMS.HTTP_PORT]: 9926,
	[CONFIG_PARAMS.AUTHENTICATION_AUTHORIZELOCAL]: true,
	[CONFIG_PARAMS.THREADS_COUNT]: 1,
	[CONFIG_PARAMS.THREADS_DEBUG]: true,
	[CONFIG_PARAMS.LOGGING_STDSTREAMS]: true,
	[CONFIG_PARAMS.LOGGING_LEVEL]: 'info',
	[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT]: 9925,
	[CONFIG_PARAMS.LOCALSTUDIO_ENABLED]: true,
};

// Install prompts
const INSTALL_PROMPTS = {
	DESTINATION: 'Please enter a destination for HarperDB:',
	HDB_USERNAME: 'Please enter a username for the administrative user:',
	HDB_PASS: 'Please enter a password for the administrative user:',
	NODE_NAME: 'Please enter a unique name for this node:',
	CLUSTER_USERNAME: 'Please enter a username for the CLUSTER_USER:',
	CLUSTER_PASS: 'Please enter a password for the CLUSTER_USER:',
	DEFAULTS_MODE: 'Default Config - dev (easy access/debugging) or prod (security/performance): (dev/prod)',
	REPLICATION_HOSTNAME: 'Please enter the hostname for this server:',
};

const cfg_env = assignCMDENVVariables([hdb_terms.INSTALL_PROMPTS.HDB_CONFIG]);
let hdb_root = undefined;
let conditional_rollback = false;
let ignore_existing = false;
let skip_hostname = false;

/**
 * This module orchestrates the installation of HarperDB.
 */

module.exports = { install, updateConfigEnv, setIgnoreExisting };
install.createSuperUser = createSuperUser;

/**
 * Calls all the functions that are needed to install HarperDB.
 * @returns {Promise<void>}
 */
async function install() {
	console.log(HDB_PROMPT_MSG(LINE_BREAK + INSTALL_START_MSG + LINE_BREAK));
	hdb_logger.notify(INSTALL_START_MSG);

	let config_from_file;
	if (cfg_env[hdb_terms.INSTALL_PROMPTS.HDB_CONFIG]) {
		config_from_file = getConfigFromFile();
	}

	// Check to see if any cmd/env vars are passed that override install prompts.
	const prompt_override = checkForPromptOverride();
	Object.assign(prompt_override, config_from_file);
	// For backwards compatibility for a time before DEFAULTS_MODE (and host name) assume prod when these args used
	if (
		prompt_override[hdb_terms.INSTALL_PROMPTS.TC_AGREEMENT] &&
		prompt_override[hdb_terms.INSTALL_PROMPTS.ROOTPATH] &&
		prompt_override[hdb_terms.INSTALL_PROMPTS.HDB_ADMIN_USERNAME] &&
		prompt_override[hdb_terms.INSTALL_PROMPTS.HDB_ADMIN_PASSWORD] &&
		prompt_override[hdb_terms.INSTALL_PROMPTS.DEFAULTS_MODE] === undefined
	) {
		skip_hostname = true;
		prompt_override[hdb_terms.INSTALL_PROMPTS.DEFAULTS_MODE] = 'prod';
	}

	// Validate any cmd/env params passed to install
	const validation_error = install_validator(prompt_override);
	if (validation_error) {
		throw validation_error.message;
	}

	// Check for an existing install of HarperDB.
	await checkForExistingInstall();

	// Ask the user to accept terms & conditions.
	await termsAgreement(prompt_override);

	// Prompt the user with params needed for install.
	const install_params = await installPrompts(prompt_override);

	// HDB root is the one of the first params we need for install.
	hdb_root = install_params[hdb_terms.INSTALL_PROMPTS.ROOTPATH];

	if (
		cfg_env[hdb_terms.INSTALL_PROMPTS.HDB_CONFIG] &&
		path.dirname(cfg_env[hdb_terms.INSTALL_PROMPTS.HDB_CONFIG]) === hdb_root
	) {
		conditional_rollback = true;
	}

	// We allow HDB to run without a boot file we check for a harperdb-config.yaml
	if (
		!ignore_existing &&
		!cfg_env[hdb_terms.INSTALL_PROMPTS.HDB_CONFIG] &&
		(await fs.pathExists(path.join(hdb_root, hdb_terms.HDB_CONFIG_FILE)))
	) {
		console.error(HDB_EXISTS_MSG);
		process.exit();
	}

	const spinner = ora({
		prefixText: HDB_PROMPT_MSG('Installing'),
		color: 'magenta',
		spinner: 'simpleDots',
	});
	spinner.start();

	if (hdb_utils.isEmpty(hdb_root)) {
		throw new Error('Installer should have the HDB root param at the stage it is in but it does not.');
	}
	env_manager.setHdbBasePath(hdb_root);

	// Creates the HarperDB project folder structure and the LMDB environments/dbis.
	await mount_hdb(hdb_root);

	// Creates the boot prop file in user home dir. Boot prop file contains location of hdb config.
	await createBootPropertiesFile();

	// Create the harperdb-config.yaml file
	await createConfigFile(install_params);

	// At this point there should be config and HarperDB folders so re-init log settings to update
	hdb_logger.initLogSettings(true);

	// Create the super user.
	await createSuperUser(install_params);

	// Create cluster user if clustering params are passed to install.
	await createClusterUser(install_params);

	// Create cert and private keys.
	await keys.updateConfigCert();
	await keys.generateCertsKeys();

	// Insert current version of HarperDB into versions table.
	await insertHdbVersionInfo();

	// Checks that the RSA keys exist for JWT generation, if not we create them.
	check_jwt_tokens();

	spinner.stop();

	console.log(HDB_PROMPT_MSG(LINE_BREAK + INSTALL_COMPLETE_MSG + LINE_BREAK));
	hdb_logger.notify(INSTALL_COMPLETE_MSG);
}

function getConfigFromFile() {
	let doc = YAML.parseDocument(fs.readFileSync(cfg_env[hdb_terms.INSTALL_PROMPTS.HDB_CONFIG], 'utf8'), {
		simpleKeys: true,
	});
	const flat_cfg = config_utils.flattenConfig(doc.toJSON());

	// This ensures that if config file has rootpath, rootpath install prompt uses this value
	if (flat_cfg[hdb_terms.CONFIG_PARAMS.ROOTPATH.toLowerCase()])
		flat_cfg.ROOTPATH = flat_cfg[hdb_terms.CONFIG_PARAMS.ROOTPATH.toLowerCase()];

	return flat_cfg;
}

/**
 * Asks the user the questions needed to get HarperDB installed.
 * If cmd/env vats are passed to install the prompts will not be asked.
 * @param prompt_override - an object that contains all the params needed to install.
 * @returns {Promise<*>}
 */
async function installPrompts(prompt_override) {
	hdb_logger.trace('Getting install prompts and params.');

	let admin_username;
	const prompts_schema = [
		{
			type: 'input',
			transformer: PROMPT_ANSWER_TRANSFORMER,
			when: displayCmdEnvVar(prompt_override[hdb_terms.INSTALL_PROMPTS.ROOTPATH], INSTALL_PROMPTS.DESTINATION),
			name: hdb_terms.INSTALL_PROMPTS.ROOTPATH,
			prefix: PROMPT_PREFIX,
			default: DEFAULT_HDB_ROOT,
			validate: async (value) => {
				if (checkForEmptyValue(value)) return checkForEmptyValue(value);
				if (await fs.pathExists(path.join(value, 'system', 'hdb_user.mdb')))
					return `'${value}' is already in use. Please enter a different path.`;
				return true;
			},
			message: HDB_PROMPT_MSG(INSTALL_PROMPTS.DESTINATION),
		},
		{
			type: 'input',
			transformer: PROMPT_ANSWER_TRANSFORMER,
			when: displayCmdEnvVar(
				prompt_override[hdb_terms.INSTALL_PROMPTS.HDB_ADMIN_USERNAME],
				INSTALL_PROMPTS.HDB_USERNAME
			),
			name: hdb_terms.INSTALL_PROMPTS.HDB_ADMIN_USERNAME,
			prefix: PROMPT_PREFIX,
			default: DEFAULT_ADMIN_USERNAME,
			validate: (value) => {
				if (checkForEmptyValue(value)) return checkForEmptyValue(value);
				// Saving username so it can be used for clustering username validation.
				admin_username = value;
				return true;
			},
			message: HDB_PROMPT_MSG(INSTALL_PROMPTS.HDB_USERNAME),
		},
		{
			type: 'password',
			when: displayCmdEnvVar(prompt_override[hdb_terms.INSTALL_PROMPTS.HDB_ADMIN_PASSWORD], INSTALL_PROMPTS.HDB_PASS),
			name: hdb_terms.INSTALL_PROMPTS.HDB_ADMIN_PASSWORD,
			prefix: PROMPT_PREFIX,
			validate: (value) => {
				if (checkForEmptyValue(value)) return checkForEmptyValue(value);
				return true;
			},
			message: HDB_PROMPT_MSG(INSTALL_PROMPTS.HDB_PASS),
		},
		{
			type: 'input',
			transformer: PROMPT_ANSWER_TRANSFORMER,
			when: displayCmdEnvVar(prompt_override[hdb_terms.INSTALL_PROMPTS.DEFAULTS_MODE], INSTALL_PROMPTS.DEFAULTS_MODE),
			name: hdb_terms.INSTALL_PROMPTS.DEFAULTS_MODE,
			prefix: PROMPT_PREFIX,
			default: DEFAULT_CONFIG_MODE,
			validate: (value) => {
				if (checkForEmptyValue(value)) return checkForEmptyValue(value);
				if (value !== 'dev' && value !== 'prod') {
					return `Invalid response '${value}', options are 'dev' or 'prod'.`;
				}
				return true;
			},
			message: HDB_PROMPT_MSG(INSTALL_PROMPTS.DEFAULTS_MODE),
		},
	];

	if (!skip_hostname) {
		prompts_schema.push({
			type: 'input',
			name: hdb_terms.INSTALL_PROMPTS.REPLICATION_HOSTNAME,
			transformer: PROMPT_ANSWER_TRANSFORMER,
			when: displayCmdEnvVar(
				prompt_override[hdb_terms.INSTALL_PROMPTS.REPLICATION_HOSTNAME],
				INSTALL_PROMPTS.REPLICATION_HOSTNAME
			),
			prefix: PROMPT_PREFIX,
			default: DEFAULT_HOST_NAME,
			message: HDB_PROMPT_MSG(INSTALL_PROMPTS.REPLICATION_HOSTNAME),
		});
	}

	// If clustering is enabled we add a couple more clustering question to the install.
	if (hdb_utils.autoCastBoolean(prompt_override[hdb_terms.INSTALL_PROMPTS.CLUSTERING_ENABLED]) === true) {
		const clustering_prompt_schema = [
			{
				type: 'input',
				transformer: PROMPT_ANSWER_TRANSFORMER,
				when: displayCmdEnvVar(
					prompt_override[hdb_terms.INSTALL_PROMPTS.CLUSTERING_NODENAME],
					INSTALL_PROMPTS.NODE_NAME
				),
				name: hdb_terms.INSTALL_PROMPTS.CLUSTERING_NODENAME,
				prefix: PROMPT_PREFIX,
				default: hri.random(),
				validate: (value) => {
					if (!NODE_NAME_REGEX.test(value)) return 'Invalid node name, must not contain ., * or >';
					return true;
				},
				message: HDB_PROMPT_MSG(INSTALL_PROMPTS.NODE_NAME),
			},
			{
				type: 'input',
				transformer: PROMPT_ANSWER_TRANSFORMER,
				when: displayCmdEnvVar(
					prompt_override[hdb_terms.INSTALL_PROMPTS.CLUSTERING_USER],
					INSTALL_PROMPTS.CLUSTER_USERNAME
				),
				name: hdb_terms.INSTALL_PROMPTS.CLUSTERING_USER,
				prefix: PROMPT_PREFIX,
				default: DEFAULT_CLUSTER_USERNAME,
				validate: (value) => {
					if (checkForEmptyValue(value)) return checkForEmptyValue(value);
					if (value.toLowerCase() === admin_username.toLowerCase()) return 'Username is already in use.';
					return true;
				},
				message: HDB_PROMPT_MSG(INSTALL_PROMPTS.CLUSTER_USERNAME),
			},
			{
				type: 'password',
				when: displayCmdEnvVar(
					prompt_override[hdb_terms.INSTALL_PROMPTS.CLUSTERING_PASSWORD],
					INSTALL_PROMPTS.CLUSTER_PASS
				),
				name: hdb_terms.INSTALL_PROMPTS.CLUSTERING_PASSWORD,
				prefix: PROMPT_PREFIX,
				validate: (value) => {
					if (checkForEmptyValue(value)) return checkForEmptyValue(value);
					return true;
				},
				message: HDB_PROMPT_MSG(INSTALL_PROMPTS.CLUSTER_PASS),
			},
		];

		prompts_schema.push(...clustering_prompt_schema);
	}

	const answers = await inquirer.prompt(prompts_schema);
	// If there are no answers all the prompts have been overridden.
	if (Object.keys(answers).length === 0) {
		return prompt_override;
	}

	// Loop through the answers and if they dont exist in the prompt_override obj add them.
	for (const param in answers) {
		if (prompt_override[param] === undefined) {
			prompt_override[param] = answers[param];
		}
	}

	return prompt_override;
}

/**
 * Used to log prompt override values. A boolean is returned because this will
 * determine if the prompt is called or not.
 * @param value
 * @param msg
 * @returns {boolean}
 */
function displayCmdEnvVar(value, msg) {
	if (value !== undefined) {
		if (msg.includes('password')) {
			console.log(`${HDB_PROMPT_MSG(msg)} ${chalk.gray('[hidden]')}`);
			hdb_logger.trace(`${HDB_PROMPT_MSG(msg)} [hidden]`);
		} else {
			console.log(`${HDB_PROMPT_MSG(msg)} ${value}`);
			hdb_logger.trace(`${HDB_PROMPT_MSG(msg)} ${value}`);
		}
		return false;
	}

	return true;
}

/**
 * Checks for an empty value.
 * @param value
 * @returns {string|undefined}
 */
function checkForEmptyValue(value) {
	const val = value.replace(/ /g, '');
	if (val === '' || val === "''" || val === '""') {
		return 'Value cannot be empty.';
	}

	return undefined;
}

/**
 * Check the cmd/env vars for any values that should override the install prompts.
 */
function checkForPromptOverride() {
	const install_prompts_array = Object.keys(hdb_terms.INSTALL_PROMPTS);
	// The config refactor meant that some config values have multiple key names (old and new). Also some of the
	// prompts are not config file values. For this reason we search twice for any matching cmd/env vars.
	const prompt_cmdenv_args = assignCMDENVVariables(install_prompts_array);
	const config_cmdenv_args = assignCMDENVVariables(Object.keys(hdb_terms.CONFIG_PARAM_MAP), true);
	const override_values = {};

	for (const install_prompt of install_prompts_array) {
		// Get the config param for a prompt. There will be only one config param for a config value, this is the value
		// that corresponds to a position in the config yaml file. This can be undefined because some of the prompts are
		// not config file values.
		const config_param = hdb_terms.CONFIG_PARAM_MAP[install_prompt.toLowerCase()];

		// If cmd/env var is passed that matches one of the install wizard prompts add it to override values object.
		if (prompt_cmdenv_args[install_prompt]) {
			if (config_param === undefined) {
				override_values[install_prompt] = prompt_cmdenv_args[install_prompt];
			} else {
				override_values[config_param.toUpperCase()] = prompt_cmdenv_args[install_prompt];
			}

			// If the prompt has a corresponding config param and that config param is present in the cmd/env vars, set that value
			// to its corresponding prompt value.
		} else if (config_param !== undefined && config_cmdenv_args[config_param.toLowerCase()]) {
			override_values[install_prompt] = config_cmdenv_args[config_param.toLowerCase()];
		}
	}

	return override_values;
}

/**
 * Checks for an existing install of HarperDB and prompts user accordingly.
 * @returns {Promise<void>}
 */
async function checkForExistingInstall() {
	hdb_logger.trace('Checking for existing install.');
	const boot_prop_path = hdb_utils.getPropsFilePath();
	const boot_file_exists = await fs.pathExists(boot_prop_path);

	let hdb_exists;
	if (boot_file_exists) {
		hdb_logger.trace(`Install found an existing boot prop file at:${boot_prop_path}`);
		const hdb_properties = PropertiesReader(boot_prop_path);
		const config_file_path =
			config_utils.getConfigValue(hdb_terms.BOOT_PROP_PARAMS.SETTINGS_PATH_KEY) ||
			hdb_properties.get(hdb_terms.BOOT_PROP_PARAMS.SETTINGS_PATH_KEY);
		hdb_exists = await fs.pathExists(config_file_path);
	}

	// If the boot file doesn't exist check to see if cli/env root path has been passed and
	// is pointing to an installed HDB
	if (!boot_file_exists && hdb_utils.noBootFile()) hdb_exists = true;

	if (hdb_exists && !ignore_existing) {
		hdb_logger.trace(`Install found existing HDB config at:${boot_prop_path}`);
		// getVersionUpdateInfo will only return an obj if there is an upgrade directive for the new version.
		const upgrade_obj = await hdb_info_controller.getVersionUpdateInfo();
		if (upgrade_obj) {
			const upgrade_to_ver_msg = `Please use \`harperdb upgrade\` to update to ${packageJson.version}. Exiting install...`;
			console.log(LINE_BREAK + chalk.magenta.bold(UPGRADE_MSG));
			console.log(chalk.magenta.bold(upgrade_to_ver_msg));
			hdb_logger.error(upgrade_to_ver_msg);
		} else {
			console.log(LINE_BREAK + chalk.magenta.bold(HDB_EXISTS_MSG));
			hdb_logger.error(HDB_EXISTS_MSG);
		}
		process.exit(0);
	}
}

/**
 * Prompt the use to accept terms & conditions.
 * Prompt can be overridden by env/cmd var.
 * If 'yes' is not provided install process is exited.
 * @param prompt_override
 * @returns {Promise<void>}
 */
async function termsAgreement(prompt_override) {
	hdb_logger.info('Asking for terms agreement.');
	const tc_msg = `Terms & Conditions can be found at ${TERMS_ADDRESS}${LINE_BREAK}and can be viewed by typing or copying and pasting the URL into your web browser.${LINE_BREAK}I agree to the HarperDB Terms and Conditions: (yes/no)`;

	const terms_question = {
		prefix: PROMPT_PREFIX,
		transformer: PROMPT_ANSWER_TRANSFORMER,
		when: displayCmdEnvVar(prompt_override[hdb_terms.INSTALL_PROMPTS.TC_AGREEMENT], tc_msg),
		name: hdb_terms.INSTALL_PROMPTS.TC_AGREEMENT,
		message: HDB_PROMPT_MSG(tc_msg),
		validate: (input) => {
			if (input.toLowerCase() === 'yes' || input.toLowerCase() === 'no') {
				return true;
			}

			return chalk.yellow(`Please enter 'yes' or 'no'`);
		},
	};

	// If the TCs aren't accepted the install process is exited.
	const tc_result = await inquirer.prompt([terms_question]);
	if (
		tc_result[hdb_terms.INSTALL_PROMPTS.TC_AGREEMENT] &&
		tc_result[hdb_terms.INSTALL_PROMPTS.TC_AGREEMENT].toLowerCase() !== ACCEPTABLE_TC_RESPONSE
	) {
		console.log(chalk.yellow(TC_NOT_ACCEPTED));
		hdb_logger.error(TC_NOT_ACCEPTED);
		process.exit(0);
	}
}

async function createBootPropertiesFile() {
	const config_file_path = path.join(hdb_root, hdb_terms.HDB_CONFIG_FILE);

	let install_user;
	try {
		install_user = os.userInfo().username;
	} catch (err) {
		// this could fail on android, try env variables
		install_user =
			process.env.USERNAME || process.env.USER || process.env.LOGNAME || process.env.LNAME || process.env.SUDO_USER;
	}

	if (install_user) {
		const boot_props_value = `settings_path = ${config_file_path}
    install_user = ${install_user}`;

		const home_dir = hdb_utils.getHomeDir();
		const home_dir_path = path.join(home_dir, hdb_terms.HDB_HOME_DIR_NAME);
		const home_dir_keys_dir_path = path.join(home_dir_path, hdb_terms.LICENSE_KEY_DIR_NAME);

		try {
			fs.mkdirpSync(home_dir_path, { mode: hdb_terms.HDB_FILE_PERMISSIONS });
			fs.mkdirpSync(home_dir_keys_dir_path, { mode: hdb_terms.HDB_FILE_PERMISSIONS });
		} catch (err) {
			console.error(
				`Could not make settings directory ${hdb_terms.HDB_HOME_DIR_NAME} in home directory.  Please check your permissions and try again.`
			);
		}

		const props_file_path = path.join(home_dir_path, hdb_terms.BOOT_PROPS_FILE_NAME);
		try {
			await fs.writeFile(props_file_path, boot_props_value);
		} catch (err) {
			hdb_logger.error(`There was an error creating the boot file at path: ${props_file_path}`);
			throw err;
		}

		env_manager.setProperty(hdb_terms.HDB_SETTINGS_NAMES.INSTALL_USER, `${install_user}`);
		env_manager.setProperty(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, config_file_path);
		env_manager.setProperty(env_manager.BOOT_PROPS_FILE_PATH, props_file_path);
	}
}

/**
 * Calls the util function that creates the HarperDB config file.
 * If an error occurs during the create install is rolled backed.
 * @param install_params
 * @returns {Promise<void>}
 */
async function createConfigFile(install_params) {
	hdb_logger.trace('Creating HarperDB config file');
	const args = assignCMDENVVariables(Object.keys(hdb_terms.CONFIG_PARAM_MAP), true);
	Object.assign(args, install_params);

	// If installing in dev mode set dev config defaults
	if (install_params[hdb_terms.INSTALL_PROMPTS.DEFAULTS_MODE] === 'dev') {
		process.env.DEV_MODE = 'true';
		for (const cfg in DEV_MODE_CONFIG) {
			// Before setting http.port check that secure port is not being passed
			if (cfg === CONFIG_PARAMS.HTTP_PORT && args[CONFIG_PARAMS.HTTP_SECUREPORT.toLowerCase()] === undefined) {
				args[cfg] = args[cfg.toLowerCase()] ?? DEV_MODE_CONFIG[cfg];
				// set secure port to null to override default
				args[CONFIG_PARAMS.HTTP_SECUREPORT] = null;
				continue;
			} else if (cfg === CONFIG_PARAMS.HTTP_PORT) {
				continue;
			}

			// Before setting ops API port check that secure port is not being passed
			if (
				cfg === CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT &&
				args[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT.toLowerCase()] === undefined
			) {
				args[cfg] = args[cfg.toLowerCase()] ?? DEV_MODE_CONFIG[cfg];
				// set secure port to null to override default
				args[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT] = null;
				continue;
			} else if (cfg === CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT) {
				continue;
			}

			if (args[cfg.toLowerCase()] === undefined) args[cfg] = DEV_MODE_CONFIG[cfg];
		}
	} else {
		if (args[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT.toLowerCase()])
			args[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT] = null;
		if (args[CONFIG_PARAMS.HTTP_PORT.toLowerCase()]) args[CONFIG_PARAMS.HTTP_SECUREPORT] = null;
	}

	try {
		if (!cfg_env[hdb_terms.INSTALL_PROMPTS.HDB_CONFIG]) {
			// Create the HarperDB config file.
			config_utils.createConfigFile(args);
		}

		env_manager.initSync();
	} catch (config_err) {
		rollbackInstall(config_err);
	}
}

/**
 * Used to remove the .harperdb and hdb folder if there is an error with creating the config file.
 * @param err_msg
 */
function rollbackInstall(err_msg) {
	hdb_logger.error(`Error creating HarperDB config file. Rolling back install - ${err_msg}`);
	console.error(err_msg);
	console.error(ABORT_MSG);

	// Remove boot file folder.
	const harperdb_boot_folder = path.resolve(env_manager.get(env_manager.BOOT_PROPS_FILE_PATH), '../');
	if (harperdb_boot_folder) {
		fs.removeSync(harperdb_boot_folder);
	}

	// Remove HDB.
	if (hdb_root) {
		// We do a conditional rollback if installing from config file that exists in the hdb rootpath
		if (conditional_rollback) {
			const dir = fs.readdirSync(hdb_root, { withFileTypes: true });
			dir.forEach((d) => {
				const full_path = path.join(d.path, d.name);
				if (full_path !== cfg_env[hdb_terms.INSTALL_PROMPTS.HDB_CONFIG]) {
					fs.removeSync(full_path);
				}
			});
		} else {
			fs.removeSync(hdb_root);
		}
	}

	process.exit(1);
}

/**
 * Creates a HarperDB role and then adds a use to that role.
 * @param role
 * @param admin_user
 * @returns {Promise<void>}
 */
async function createAdminUser(role, admin_user) {
	hdb_logger.trace('Creating admin user');

	await p_schema_to_global();
	let role_response;
	try {
		role_response = await role_ops.addRole(role);
	} catch (err) {
		// This is here to allow installs overtop of existing user/roles tables
		if (err.message.includes('already exists')) {
			admin_user = undefined;
		} else {
			err.message += 'Error creating role';
			throw err;
		}
	}

	if (admin_user) {
		try {
			admin_user.role = role_response.role;
			await user_ops.addUser(admin_user);
		} catch (err) {
			err.message = `Error creating user - ${err}`;
			throw err;
		}
	}
}

/**
 * Create HDB admin user with input from user.
 * @param install_params
 * @returns {Promise<void>}
 */
async function createSuperUser(install_params) {
	hdb_logger.trace('Creating Super user.');
	const role = {
		role: 'super_user',
		permission: {
			super_user: true,
		},
	};

	const user = {
		username: install_params[hdb_terms.INSTALL_PROMPTS.HDB_ADMIN_USERNAME].toString(),
		password: install_params[hdb_terms.INSTALL_PROMPTS.HDB_ADMIN_PASSWORD].toString(),
		active: true,
	};

	await createAdminUser(role, user);
	delete install_params[hdb_terms.INSTALL_PROMPTS.HDB_ADMIN_USERNAME];
	delete install_params[hdb_terms.INSTALL_PROMPTS.HDB_ADMIN_PASSWORD];
}

/**
 * Creates the cluster_user role and if a cluster user is passed to install it
 * will add that user with the cluster_user role.
 * @param install_params
 * @returns {Promise<void>}
 */
async function createClusterUser(install_params) {
	hdb_logger.trace('Creating Cluster user.');
	let user = undefined;
	if (
		install_params[hdb_terms.INSTALL_PROMPTS.CLUSTERING_USER] &&
		install_params[hdb_terms.INSTALL_PROMPTS.CLUSTERING_PASSWORD]
	) {
		user = {
			username: install_params[hdb_terms.INSTALL_PROMPTS.CLUSTERING_USER].toString(),
			password: install_params[hdb_terms.INSTALL_PROMPTS.CLUSTERING_PASSWORD].toString(),
			active: true,
		};
	}

	const role = {
		role: 'cluster_user',
		permission: {
			cluster_user: true,
		},
	};

	await createAdminUser(role, user);
	delete install_params[hdb_terms.INSTALL_PROMPTS.CLUSTERING_USER];
	delete install_params[hdb_terms.INSTALL_PROMPTS.CLUSTERING_PASSWORD];
}

/**
 * Makes a call to insert the hdb_info table with the newly installed version,
 * @returns {Promise<void>}
 */
async function insertHdbVersionInfo() {
	const vers = packageJson.version;
	if (vers) {
		await hdb_info_controller.insertHdbInstallInfo(vers);
	} else {
		throw new Error('The version is missing/removed from HarperDB package.json');
	}
}

function updateConfigEnv(value) {
	cfg_env[hdb_terms.INSTALL_PROMPTS.HDB_CONFIG] = value;
}

function setIgnoreExisting(value) {
	ignore_existing = value;
}
