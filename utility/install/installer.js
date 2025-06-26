'use strict';

const os = require('os');
const inquirer = require('inquirer');
const fs = require('fs-extra');
const PropertiesReader = require('properties-reader');
const chalk = require('chalk');
const path = require('path');
const hri = require('human-readable-ids').hri;
let ora; // Will be loaded dynamically as it's an ES module
const YAML = require('yaml');

const hdbLogger = require('../logging/harper_logger.js');
const envManager = require('../environment/environmentManager.js');
const hdbUtils = require('../common_utils.js');
const assignCMDENVVariables = require('../../utility/assignCmdEnvVariables.js');
const hdbInfoController = require('../../dataLayer/hdbInfoController.js');
const { packageJson } = require('../packageUtils.js');
const hdbTerms = require('../hdbTerms.ts');
const { CONFIG_PARAM_MAP, CONFIG_PARAMS } = hdbTerms;
const installValidator = require('../../validation/installValidator.js');
const mountHdb = require('../mount_hdb.js');
const configUtils = require('../../config/configUtils.js');
const userOps = require('../../security/user.js');
const roleOps = require('../../security/role.js');
const checkJwtTokens = require('./checkJWTTokensExist.js');
const globalSchema = require('../globalSchema.js');
const promisify = require('util').promisify;
const pSchemaToGlobal = promisify(globalSchema.setSchemaDataToGlobal);
const keys = require('../../security/keys.js');

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
const DEFAULT_HDB_ROOT = path.join(PROCESS_HOME, hdbTerms.HDB_ROOT_DIR_NAME);
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

const cfgEnv = assignCMDENVVariables([hdbTerms.INSTALL_PROMPTS.HDB_CONFIG]);
let hdbRoot = undefined;
let conditionalRollback = false;
let ignoreExisting = false;
let skipHostname = false;

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
	hdbLogger.notify(INSTALL_START_MSG);

	let configFromFile;
	if (cfgEnv[hdbTerms.INSTALL_PROMPTS.HDB_CONFIG]) {
		configFromFile = getConfigFromFile();
	}

	// Check to see if any cmd/env vars are passed that override install prompts.
	const promptOverride = checkForPromptOverride();
	Object.assign(promptOverride, configFromFile);
	// For backwards compatibility for a time before DEFAULTS_MODE (and host name) assume prod when these args used
	if (
		promptOverride[hdbTerms.INSTALL_PROMPTS.TC_AGREEMENT] &&
		promptOverride[hdbTerms.INSTALL_PROMPTS.ROOTPATH] &&
		promptOverride[hdbTerms.INSTALL_PROMPTS.HDB_ADMIN_USERNAME] &&
		promptOverride[hdbTerms.INSTALL_PROMPTS.HDB_ADMIN_PASSWORD] &&
		promptOverride[hdbTerms.INSTALL_PROMPTS.DEFAULTS_MODE] === undefined
	) {
		skipHostname = true;
		promptOverride[hdbTerms.INSTALL_PROMPTS.DEFAULTS_MODE] = 'prod';
	}

	// Validate any cmd/env params passed to install
	const validationError = installValidator(promptOverride);
	if (validationError) {
		throw validationError.message;
	}

	// Check for an existing install of HarperDB.
	await checkForExistingInstall();

	// Ask the user to accept terms & conditions.
	await termsAgreement(promptOverride);

	// Prompt the user with params needed for install.
	const installParams = await installPrompts(promptOverride);

	// HDB root is the one of the first params we need for install.
	hdbRoot = installParams[hdbTerms.INSTALL_PROMPTS.ROOTPATH];

	if (
		cfgEnv[hdbTerms.INSTALL_PROMPTS.HDB_CONFIG] &&
		path.dirname(cfgEnv[hdbTerms.INSTALL_PROMPTS.HDB_CONFIG]) === hdbRoot
	) {
		conditionalRollback = true;
	}

	// We allow HDB to run without a boot file we check for a harperdb-config.yaml
	if (
		!ignoreExisting &&
		!cfgEnv[hdbTerms.INSTALL_PROMPTS.HDB_CONFIG] &&
		(await fs.pathExists(path.join(hdbRoot, hdbTerms.HDB_CONFIG_FILE)))
	) {
		console.error(HDB_EXISTS_MSG);
		process.exit();
	}

	if (!ora) {
		ora = (await import('ora')).default;
	}
	const spinner = ora({
		prefixText: HDB_PROMPT_MSG('Installing'),
		color: 'magenta',
		spinner: 'simpleDots',
	});
	spinner.start();

	if (hdbUtils.isEmpty(hdbRoot)) {
		throw new Error('Installer should have the HDB root param at the stage it is in but it does not.');
	}
	envManager.setHdbBasePath(hdbRoot);

	// Creates the HarperDB project folder structure and the LMDB environments/dbis.
	await mountHdb(hdbRoot);

	// Creates the boot prop file in user home dir. Boot prop file contains location of hdb config.
	await createBootPropertiesFile();

	// Create the harperdb-config.yaml file
	await createConfigFile(installParams);

	// At this point there should be config and HarperDB folders so re-init log settings to update
	hdbLogger.initLogSettings(true);

	// Create the super user.
	await createSuperUser(installParams);

	// Create cluster user if clustering params are passed to install.
	await createClusterUser(installParams);

	// Create cert and private keys.
	await keys.updateConfigCert();
	await keys.generateCertsKeys();

	// Insert current version of HarperDB into versions table.
	await insertHdbVersionInfo();

	// Checks that the RSA keys exist for JWT generation, if not we create them.
	checkJwtTokens();

	spinner.stop();

	console.log(HDB_PROMPT_MSG(LINE_BREAK + INSTALL_COMPLETE_MSG + LINE_BREAK));
	hdbLogger.notify(INSTALL_COMPLETE_MSG);
}

function getConfigFromFile() {
	let doc = YAML.parseDocument(fs.readFileSync(cfgEnv[hdbTerms.INSTALL_PROMPTS.HDB_CONFIG], 'utf8'), {
		simpleKeys: true,
	});
	const flatCfg = configUtils.flattenConfig(doc.toJSON());

	// This ensures that if config file has rootpath, rootpath install prompt uses this value
	if (flatCfg[hdbTerms.CONFIG_PARAMS.ROOTPATH.toLowerCase()])
		flatCfg.ROOTPATH = flatCfg[hdbTerms.CONFIG_PARAMS.ROOTPATH.toLowerCase()];

	return flatCfg;
}

/**
 * Asks the user the questions needed to get HarperDB installed.
 * If cmd/env vats are passed to install the prompts will not be asked.
 * @param promptOverride - an object that contains all the params needed to install.
 * @returns {Promise<*>}
 */
async function installPrompts(promptOverride) {
	hdbLogger.trace('Getting install prompts and params.');

	let adminUsername;
	const promptsSchema = [
		{
			type: 'input',
			transformer: PROMPT_ANSWER_TRANSFORMER,
			when: displayCmdEnvVar(promptOverride[hdbTerms.INSTALL_PROMPTS.ROOTPATH], INSTALL_PROMPTS.DESTINATION),
			name: hdbTerms.INSTALL_PROMPTS.ROOTPATH,
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
				promptOverride[hdbTerms.INSTALL_PROMPTS.HDB_ADMIN_USERNAME],
				INSTALL_PROMPTS.HDB_USERNAME
			),
			name: hdbTerms.INSTALL_PROMPTS.HDB_ADMIN_USERNAME,
			prefix: PROMPT_PREFIX,
			default: DEFAULT_ADMIN_USERNAME,
			validate: (value) => {
				if (checkForEmptyValue(value)) return checkForEmptyValue(value);
				// Saving username so it can be used for clustering username validation.
				adminUsername = value;
				return true;
			},
			message: HDB_PROMPT_MSG(INSTALL_PROMPTS.HDB_USERNAME),
		},
		{
			type: 'password',
			when: displayCmdEnvVar(promptOverride[hdbTerms.INSTALL_PROMPTS.HDB_ADMIN_PASSWORD], INSTALL_PROMPTS.HDB_PASS),
			name: hdbTerms.INSTALL_PROMPTS.HDB_ADMIN_PASSWORD,
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
			when: displayCmdEnvVar(promptOverride[hdbTerms.INSTALL_PROMPTS.DEFAULTS_MODE], INSTALL_PROMPTS.DEFAULTS_MODE),
			name: hdbTerms.INSTALL_PROMPTS.DEFAULTS_MODE,
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

	if (!skipHostname) {
		promptsSchema.push({
			type: 'input',
			name: hdbTerms.INSTALL_PROMPTS.REPLICATION_HOSTNAME,
			transformer: PROMPT_ANSWER_TRANSFORMER,
			when: displayCmdEnvVar(
				promptOverride[hdbTerms.INSTALL_PROMPTS.REPLICATION_HOSTNAME],
				INSTALL_PROMPTS.REPLICATION_HOSTNAME
			),
			prefix: PROMPT_PREFIX,
			default: DEFAULT_HOST_NAME,
			message: HDB_PROMPT_MSG(INSTALL_PROMPTS.REPLICATION_HOSTNAME),
		});
	}

	// If clustering is enabled we add a couple more clustering question to the install.
	if (hdbUtils.autoCastBoolean(promptOverride[hdbTerms.INSTALL_PROMPTS.CLUSTERING_ENABLED]) === true) {
		const clusteringPromptSchema = [
			{
				type: 'input',
				transformer: PROMPT_ANSWER_TRANSFORMER,
				when: displayCmdEnvVar(
					promptOverride[hdbTerms.INSTALL_PROMPTS.CLUSTERING_NODENAME],
					INSTALL_PROMPTS.NODE_NAME
				),
				name: hdbTerms.INSTALL_PROMPTS.CLUSTERING_NODENAME,
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
					promptOverride[hdbTerms.INSTALL_PROMPTS.CLUSTERING_USER],
					INSTALL_PROMPTS.CLUSTER_USERNAME
				),
				name: hdbTerms.INSTALL_PROMPTS.CLUSTERING_USER,
				prefix: PROMPT_PREFIX,
				default: DEFAULT_CLUSTER_USERNAME,
				validate: (value) => {
					if (checkForEmptyValue(value)) return checkForEmptyValue(value);
					if (value.toLowerCase() === adminUsername.toLowerCase()) return 'Username is already in use.';
					return true;
				},
				message: HDB_PROMPT_MSG(INSTALL_PROMPTS.CLUSTER_USERNAME),
			},
			{
				type: 'password',
				when: displayCmdEnvVar(
					promptOverride[hdbTerms.INSTALL_PROMPTS.CLUSTERING_PASSWORD],
					INSTALL_PROMPTS.CLUSTER_PASS
				),
				name: hdbTerms.INSTALL_PROMPTS.CLUSTERING_PASSWORD,
				prefix: PROMPT_PREFIX,
				validate: (value) => {
					if (checkForEmptyValue(value)) return checkForEmptyValue(value);
					return true;
				},
				message: HDB_PROMPT_MSG(INSTALL_PROMPTS.CLUSTER_PASS),
			},
		];

		promptsSchema.push(...clusteringPromptSchema);
	}

	const answers = await inquirer.prompt(promptsSchema);
	// If there are no answers all the prompts have been overridden.
	if (Object.keys(answers).length === 0) {
		return promptOverride;
	}

	// Loop through the answers and if they dont exist in the promptOverride obj add them.
	for (const param in answers) {
		if (promptOverride[param] === undefined) {
			promptOverride[param] = answers[param];
		}
	}

	return promptOverride;
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
			hdbLogger.trace(`${HDB_PROMPT_MSG(msg)} [hidden]`);
		} else {
			console.log(`${HDB_PROMPT_MSG(msg)} ${value}`);
			hdbLogger.trace(`${HDB_PROMPT_MSG(msg)} ${value}`);
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
	const installPromptsArray = Object.keys(hdbTerms.INSTALL_PROMPTS);
	// The config refactor meant that some config values have multiple key names (old and new). Also some of the
	// prompts are not config file values. For this reason we search twice for any matching cmd/env vars.
	const promptCmdenvArgs = assignCMDENVVariables(installPromptsArray);
	const configCmdenvArgs = assignCMDENVVariables(Object.keys(hdbTerms.CONFIG_PARAM_MAP), true);
	const overrideValues = {};

	for (const install_prompt of installPromptsArray) {
		// Get the config param for a prompt. There will be only one config param for a config value, this is the value
		// that corresponds to a position in the config yaml file. This can be undefined because some of the prompts are
		// not config file values.
		const configParam = hdbTerms.CONFIG_PARAM_MAP[install_prompt.toLowerCase()];

		// If cmd/env var is passed that matches one of the install wizard prompts add it to override values object.
		if (promptCmdenvArgs[install_prompt]) {
			if (configParam === undefined) {
				overrideValues[install_prompt] = promptCmdenvArgs[install_prompt];
			} else {
				overrideValues[configParam.toUpperCase()] = promptCmdenvArgs[install_prompt];
			}

			// If the prompt has a corresponding config param and that config param is present in the cmd/env vars, set that value
			// to its corresponding prompt value.
		} else if (configParam !== undefined && configCmdenvArgs[configParam.toLowerCase()]) {
			overrideValues[install_prompt] = configCmdenvArgs[configParam.toLowerCase()];
		}
	}

	return overrideValues;
}

/**
 * Checks for an existing install of HarperDB and prompts user accordingly.
 * @returns {Promise<void>}
 */
async function checkForExistingInstall() {
	hdbLogger.trace('Checking for existing install.');
	const bootPropPath = hdbUtils.getPropsFilePath();
	const bootFileExists = await fs.pathExists(bootPropPath);

	let hdbExists;
	if (bootFileExists) {
		hdbLogger.trace(`Install found an existing boot prop file at:${bootPropPath}`);
		const hdbProperties = PropertiesReader(bootPropPath);
		const configFilePath =
			configUtils.getConfigValue(hdbTerms.BOOT_PROP_PARAMS.SETTINGS_PATH_KEY) ||
			hdbProperties.get(hdbTerms.BOOT_PROP_PARAMS.SETTINGS_PATH_KEY);
		hdbExists = await fs.pathExists(configFilePath);
	}

	// If the boot file doesn't exist check to see if cli/env root path has been passed and
	// is pointing to an installed HDB
	if (!bootFileExists && hdbUtils.noBootFile()) hdbExists = true;

	if (hdbExists && !ignoreExisting) {
		hdbLogger.trace(`Install found existing HDB config at:${bootPropPath}`);
		// getVersionUpdateInfo will only return an obj if there is an upgrade directive for the new version.
		const upgradeObj = await hdbInfoController.getVersionUpdateInfo();
		if (upgradeObj) {
			const upgradeToVerMsg = `Please use \`harperdb upgrade\` to update to ${packageJson.version}. Exiting install...`;
			console.log(LINE_BREAK + chalk.magenta.bold(UPGRADE_MSG));
			console.log(chalk.magenta.bold(upgradeToVerMsg));
			hdbLogger.error(upgradeToVerMsg);
		} else {
			console.log(LINE_BREAK + chalk.magenta.bold(HDB_EXISTS_MSG));
			hdbLogger.error(HDB_EXISTS_MSG);
		}
		process.exit(0);
	}
}

/**
 * Prompt the use to accept terms & conditions.
 * Prompt can be overridden by env/cmd var.
 * If 'yes' is not provided install process is exited.
 * @param promptOverride
 * @returns {Promise<void>}
 */
async function termsAgreement(promptOverride) {
	hdbLogger.info('Asking for terms agreement.');
	const tcMsg = `Terms & Conditions can be found at ${TERMS_ADDRESS}${LINE_BREAK}and can be viewed by typing or copying and pasting the URL into your web browser.${LINE_BREAK}I agree to the HarperDB Terms and Conditions: (yes/no)`;

	const termsQuestion = {
		prefix: PROMPT_PREFIX,
		transformer: PROMPT_ANSWER_TRANSFORMER,
		when: displayCmdEnvVar(promptOverride[hdbTerms.INSTALL_PROMPTS.TC_AGREEMENT], tcMsg),
		name: hdbTerms.INSTALL_PROMPTS.TC_AGREEMENT,
		message: HDB_PROMPT_MSG(tcMsg),
		validate: (input) => {
			if (input.toLowerCase() === 'yes' || input.toLowerCase() === 'no') {
				return true;
			}

			return chalk.yellow(`Please enter 'yes' or 'no'`);
		},
	};

	// If the TCs aren't accepted the install process is exited.
	const tcResult = await inquirer.prompt([termsQuestion]);
	if (
		tcResult[hdbTerms.INSTALL_PROMPTS.TC_AGREEMENT] &&
		tcResult[hdbTerms.INSTALL_PROMPTS.TC_AGREEMENT].toLowerCase() !== ACCEPTABLE_TC_RESPONSE
	) {
		console.log(chalk.yellow(TC_NOT_ACCEPTED));
		hdbLogger.error(TC_NOT_ACCEPTED);
		process.exit(0);
	}
}

async function createBootPropertiesFile() {
	const configFilePath = path.join(hdbRoot, hdbTerms.HDB_CONFIG_FILE);

	let install_user;
	try {
		install_user = os.userInfo().username;
	} catch (err) {
		// this could fail on android, try env variables
		install_user =
			process.env.USERNAME || process.env.USER || process.env.LOGNAME || process.env.LNAME || process.env.SUDO_USER;
	}

	if (install_user) {
		const bootPropsValue = `settings_path = ${configFilePath}
    install_user = ${install_user}`;

		const homeDir = hdbUtils.getHomeDir();
		const homeDirPath = path.join(homeDir, hdbTerms.HDB_HOME_DIR_NAME);
		const homeDirKeysDirPath = path.join(homeDirPath, hdbTerms.LICENSE_KEY_DIR_NAME);

		try {
			fs.mkdirpSync(homeDirPath, { mode: hdbTerms.HDB_FILE_PERMISSIONS });
			fs.mkdirpSync(homeDirKeysDirPath, { mode: hdbTerms.HDB_FILE_PERMISSIONS });
		} catch (err) {
			console.error(
				`Could not make settings directory ${hdbTerms.HDB_HOME_DIR_NAME} in home directory.  Please check your permissions and try again.`
			);
		}

		const propsFilePath = path.join(homeDirPath, hdbTerms.BOOT_PROPS_FILE_NAME);
		try {
			await fs.writeFile(propsFilePath, bootPropsValue);
		} catch (err) {
			hdbLogger.error(`There was an error creating the boot file at path: ${propsFilePath}`);
			throw err;
		}

		envManager.setProperty(hdbTerms.HDB_SETTINGS_NAMES.INSTALL_USER, `${install_user}`);
		envManager.setProperty(hdbTerms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, configFilePath);
		envManager.setProperty(envManager.BOOT_PROPS_FILE_PATH, propsFilePath);
	}
}

/**
 * Calls the util function that creates the HarperDB config file.
 * If an error occurs during the create install is rolled backed.
 * @param installParams
 * @returns {Promise<void>}
 */
async function createConfigFile(installParams) {
	hdbLogger.trace('Creating HarperDB config file');
	const args = assignCMDENVVariables(Object.keys(hdbTerms.CONFIG_PARAM_MAP), true);
	Object.assign(args, installParams);

	// If installing in dev mode set dev config defaults
	if (installParams[hdbTerms.INSTALL_PROMPTS.DEFAULTS_MODE] === 'dev') {
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
		if (!cfgEnv[hdbTerms.INSTALL_PROMPTS.HDB_CONFIG]) {
			// Create the HarperDB config file.
			configUtils.createConfigFile(args);
		}

		envManager.initSync();
	} catch (configErr) {
		rollbackInstall(configErr);
	}
}

/**
 * Used to remove the .harperdb and hdb folder if there is an error with creating the config file.
 * @param errMsg
 */
function rollbackInstall(errMsg) {
	hdbLogger.error(`Error creating HarperDB config file. Rolling back install - ${errMsg}`);
	console.error(errMsg);
	console.error(ABORT_MSG);

	// Remove boot file folder.
	const harperdbBootFolder = path.resolve(envManager.get(envManager.BOOT_PROPS_FILE_PATH), '../');
	if (harperdbBootFolder) {
		fs.removeSync(harperdbBootFolder);
	}

	// Remove HDB.
	if (hdbRoot) {
		// We do a conditional rollback if installing from config file that exists in the hdb rootpath
		if (conditionalRollback) {
			const dir = fs.readdirSync(hdbRoot, { withFileTypes: true });
			dir.forEach((d) => {
				const fullPath = path.join(d.path, d.name);
				if (fullPath !== cfgEnv[hdbTerms.INSTALL_PROMPTS.HDB_CONFIG]) {
					fs.removeSync(fullPath);
				}
			});
		} else {
			fs.removeSync(hdbRoot);
		}
	}

	process.exit(1);
}

/**
 * Creates a HarperDB role and then adds a use to that role.
 * @param role
 * @param adminUser
 * @returns {Promise<void>}
 */
async function createAdminUser(role, adminUser) {
	hdbLogger.trace('Creating admin user');

	await pSchemaToGlobal();
	let roleResponse;
	try {
		roleResponse = await roleOps.addRole(role);
	} catch (err) {
		// This is here to allow installs overtop of existing user/roles tables
		if (err.message.includes('already exists')) {
			adminUser = undefined;
		} else {
			err.message += 'Error creating role';
			throw err;
		}
	}

	if (adminUser) {
		try {
			adminUser.role = roleResponse.role;
			await userOps.addUser(adminUser);
		} catch (err) {
			err.message = `Error creating user - ${err}`;
			throw err;
		}
	}
}

/**
 * Create HDB admin user with input from user.
 * @param installParams
 * @returns {Promise<void>}
 */
async function createSuperUser(installParams) {
	hdbLogger.trace('Creating Super user.');
	const role = {
		role: 'super_user',
		permission: {
			super_user: true,
		},
	};

	const user = {
		username: installParams[hdbTerms.INSTALL_PROMPTS.HDB_ADMIN_USERNAME].toString(),
		password: installParams[hdbTerms.INSTALL_PROMPTS.HDB_ADMIN_PASSWORD].toString(),
		active: true,
	};

	await createAdminUser(role, user);
	delete installParams[hdbTerms.INSTALL_PROMPTS.HDB_ADMIN_USERNAME];
	delete installParams[hdbTerms.INSTALL_PROMPTS.HDB_ADMIN_PASSWORD];
}

/**
 * Creates the cluster_user role and if a cluster user is passed to install it
 * will add that user with the cluster_user role.
 * @param installParams
 * @returns {Promise<void>}
 */
async function createClusterUser(installParams) {
	hdbLogger.trace('Creating Cluster user.');
	let user = undefined;
	if (
		installParams[hdbTerms.INSTALL_PROMPTS.CLUSTERING_USER] &&
		installParams[hdbTerms.INSTALL_PROMPTS.CLUSTERING_PASSWORD]
	) {
		user = {
			username: installParams[hdbTerms.INSTALL_PROMPTS.CLUSTERING_USER].toString(),
			password: installParams[hdbTerms.INSTALL_PROMPTS.CLUSTERING_PASSWORD].toString(),
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
	delete installParams[hdbTerms.INSTALL_PROMPTS.CLUSTERING_USER];
	delete installParams[hdbTerms.INSTALL_PROMPTS.CLUSTERING_PASSWORD];
}

/**
 * Makes a call to insert the hdbInfo table with the newly installed version,
 * @returns {Promise<void>}
 */
async function insertHdbVersionInfo() {
	const vers = packageJson.version;
	if (vers) {
		await hdbInfoController.insertHdbInstallInfo(vers);
	} else {
		throw new Error('The version is missing/removed from HarperDB package.json');
	}
}

function updateConfigEnv(value) {
	cfgEnv[hdbTerms.INSTALL_PROMPTS.HDB_CONFIG] = value;
}

function setIgnoreExisting(value) {
	ignoreExisting = value;
}
