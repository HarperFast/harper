/**
 * INSTALLER.JS
 *
 * This module is used to install HarperDB.  It is meant to be a self contained module which is why it configures
 * it's own pino instance.
 */

const prompt = require('prompt');
const path = require('path');
const mount = require('./../mount_hdb');
const fs = require('fs-extra');
const chalk = require('chalk');
const async = require('async');
const forge = require('node-forge');
const hri = require('human-readable-ids').hri;
const terms_address = 'https://harperdb.io/legal/end-user-license-agreement';
const env = require('../../utility/environment/environmentManager');
const os = require('os');
const comm = require('../common_utils');
const assignCMDENVVariables = require('../../utility/assignCmdEnvVariables');
const hdb_terms = require('../hdbTerms');
const hdbInfoController = require('../../data_layer/hdbInfoController');
const version = require('../../bin/version');
const hdb_logger = require('../logging/harper_logger');
const check_jwt_tokens = require('./checkJWTTokensExist');
const config_utils = require('../../config/configUtils');

module.exports = {
	install: run_install,
};

// These require statements were moved below the module.exports to resolve circular dependencies within the harperBridge module.
const schema = require('../../utility/globalSchema');

let wizard_result;
let check_install_path = false;
const KEY_PAIR_BITS = 2048;
const UPGRADE_MSG = 'Please use `harperdb upgrade` to update your existing instance of HDB. Exiting install...';
const ABORT_MSG = 'Aborting install';

env.initSync();

/**
 * Stars the install process by first checking for an existing installation, then firing the steps to complete the install.
 * Information required to complete the install is root path, desired harper port, TCP port, username, and password.
 * @param callback
 */
function run_install(callback) {
	hdb_logger.createLogFile(hdb_terms.PROCESS_LOG_NAMES.INSTALL, hdb_terms.PROCESS_DESCRIPTORS.INSTALL);

	if (comm.isEmptyOrZeroLength(os.userInfo().uid)) {
		let msg = `Installing user: ${
			os.userInfo().username
		} has no pid.  Please install with a properly created user. Cancelling install.`;
		hdb_logger.error(msg);
		console.log(msg);
		return callback(msg, null);
	}

	prompt.override = checkForPromptOverride();
	prompt.start();
	hdb_logger.info('starting install');
	checkInstall(function (err, keepGoing) {
		if (keepGoing) {
			async.waterfall(
				[
					termsAgreement,
					wizard,
					async.apply(mount, hdb_logger),
					createSettingsFile,
					createSuperUser,
					createClusterUser,
					generateKeys,
					insertHdbInfo,
					(data, callback2) => {
						check_jwt_tokens();

						hdb_logger.info('Installation Successful');
						callback2();
					},
				],
				function (install_err) {
					if (install_err) {
						return callback(install_err, null);
					}
					return callback(null, null);
				}
			);
		} else {
			console.log('Exiting installer');
			process.exit(0);
		}
	});
}

/**
 * Check the cmd/env vars for any values that should override the install wizard prompts.
 */
function checkForPromptOverride() {
	const all_prompts = [
		'TC_AGREEMENT',
		'HDB_ROOT',
		'SERVER_PORT',
		'HDB_ADMIN_USERNAME',
		'HDB_ADMIN_PASSWORD',
		'CLUSTERING_USER',
		'CLUSTERING_PASSWORD',
		'CLUSTERING_PORT',
		'NODE_NAME',
		'CLUSTERING',
		'REINSTALL',
	];

	// The config refactor meant that some config values have multiple key names (old and new). Also some of the
	// prompts are not config file values. For this reason we search twice for any matching cmd/env vars.
	const prompt_cmdenv_args = assignCMDENVVariables(all_prompts);
	const config_cmdenv_args = assignCMDENVVariables(Object.keys(hdb_terms.CONFIG_PARAM_MAP), true);
	const override_values = {};

	for (const install_prompt of all_prompts) {
		// Get the config param for a prompt. There will be only one config param for a config value, this is the value
		// that corresponds to a position in the config yaml file. This can be undefined because some of the prompts are
		// not config file values.
		const config_param = hdb_terms.CONFIG_PARAM_MAP[install_prompt.toLowerCase()];

		// If cmd/env var is passed that matches one of the install wizard prompts add it to override values object.
		if (prompt_cmdenv_args[install_prompt]) {
			override_values[install_prompt] = prompt_cmdenv_args[install_prompt];
			// If the prompt has a corresponding config param and that config param is present in the cmd/env vars, set that value
			// to its corresponding prompt value.
		} else if (config_param !== undefined && config_cmdenv_args[config_param.toLowerCase()]) {
			override_values[install_prompt] = config_cmdenv_args[config_param.toLowerCase()];
		}
	}

	return override_values;
}

/**
 * Makes a call to insert the hdb_info table with the newly installed version.  This is written as a callback function
 * as we can't make the installer async until we pick a new CLI base.
 *
 * @param callback
 */
function insertHdbInfo(callback) {
	let vers = version.version();
	if (vers) {
		//Add initial hdb_info record for new install
		hdbInfoController
			.insertHdbInstallInfo(vers)
			.then((res) => {
				hdb_logger.info('Product version info was properly inserted');
				return callback(null, res);
			})
			.catch((err) => {
				hdb_logger.error('Error inserting product version info');
				hdb_logger.error(err);
				return callback(err, null);
			});
	} else {
		const err_msg = 'The version is missing/removed from package.json';
		hdb_logger.error(err_msg);
		console.log(err_msg);
		return callback(err_msg, null);
	}
}

/**
 * Prompts the user to accept the linked Terms & Conditions.  If the user does not agree, install process is killed.
 * @param {*} callback
 */
function termsAgreement(callback) {
	hdb_logger.info('Asking for terms agreement.');
	prompt.message = ``;
	const line_break = os.EOL;
	let terms_schema = {
		properties: {
			TC_AGREEMENT: {
				description: chalk.magenta(
					`Terms & Conditions can be found at ${terms_address}${line_break}and can be viewed by typing or copying and pasting the URL into your web browser.${line_break}${'[TC_AGREEMENT] I Agree to the HarperDB Terms and Conditions. (yes/no)'}`
				),
			},
		},
	};
	prompt.get(terms_schema, function (err, result) {
		if (err) {
			return callback(err);
		}
		if (result.TC_AGREEMENT === 'yes') {
			return callback(null, true);
		}
		console.log(chalk.yellow(`Terms & Conditions acceptance is required to proceed with installation.`));
		hdb_logger.error('Terms and Conditions agreement was refused.');
		return callback('REFUSED', false);
	});
}

/**
 * Checks for the presence of an existing install by finding the hdb_boot props file.  If the file is found, the user
 * is prompted for a decision to reinstall over the existing installation.
 * @param callback
 */
function checkInstall(callback) {
	hdb_logger.info('Checking for previous installation.');
	try {
		let boot_prop_path = comm.getPropsFilePath();
		fs.accessSync(boot_prop_path, fs.constants.F_OK | fs.constants.R_OK);
		env.setProperty(env.BOOT_PROPS_FILE_PATH, boot_prop_path);
		env.initSync();
		if (!env.get('HDB_ROOT')) {
			return callback(null, true);
		}
		promptForReinstall((err, result) => callback(err, result));
	} catch (err) {
		return callback(err, true);
	}
}

function promptForReinstall(callback) {
	hdbInfoController.getVersionUpdateInfo().then((res) => {
		// Check
		if (res !== undefined) {
			console.log(`${os.EOL}` + chalk.magenta.bold(UPGRADE_MSG));
			process.exit(0);
		}

		hdb_logger.info('Previous install detected, asking for reinstall.');
		let reinstall_schema = {
			properties: {
				REINSTALL: {
					description: chalk.red(
						`It appears HarperDB version ${version.version()} is already installed.  Enter 'y/yes'to reinstall. (yes/no)`
					),
					pattern: /y(es)?$|n(o)?$/,
					message: "Must respond 'yes' or 'no'",
					default: 'no',
					required: true,
				},
			},
		};
		let overwrite_schema = {
			properties: {
				KEEP_DATA: {
					description: `${os.EOL}` + chalk.red.bold('Would you like to keep your existing data in HDB?  (yes/no)'),
					pattern: /y(es)?$|n(o)?$/,
					message: "Must respond 'yes' or 'no'",
					required: true,
				},
			},
		};

		prompt.message = '';
		prompt.get(reinstall_schema, function (err, reinstall_result) {
			if (err) {
				return callback(err);
			}

			if (reinstall_result.REINSTALL === 'yes' || reinstall_result.REINSTALL === 'y') {
				check_install_path = true;
				prompt.get(overwrite_schema, function (prompt_err, overwrite_result) {
					if (overwrite_result.KEEP_DATA === 'no' || overwrite_result.KEEP_DATA === 'n') {
						// don't keep data, tear it all out.
						fs.remove(env.getHdbBasePath(), function (fs_remove_err) {
							if (fs_remove_err) {
								hdb_logger.error(fs_remove_err);
								console.log(
									'There was a problem removing the existing installation.  Please check the install log for details.'
								);
								return callback(fs_remove_err);
							}

							fs.unlink(env.get(env.BOOT_PROPS_FILE_PATH), function (fs_unlink_err) {
								if (fs_unlink_err) {
									hdb_logger.error(fs_unlink_err);
									console.log(
										'There was a problem removing the existing installation.  Please check the install log for details.'
									);
									return callback(fs_unlink_err);
								}
								return callback(null, true);
							});
						});
					} else {
						// keep data - this means they should be using the upgrade command
						console.log(`${os.EOL}` + chalk.magenta.bold(UPGRADE_MSG));
						process.exit(0);
					}
				});
			} else {
				return callback(null, false);
			}
		});
	});
}

/**
 * The install wizard will guide the user through the required data needed for the install.
 * @param err - Errors from the previous (Terms and Conditions) waterfall function.
 * @param callback
 */
function wizard(err, callback) {
	prompt.message = ``;
	hdb_logger.info('Starting install wizard');
	let admin_username;
	let install_schema = {
		properties: {
			HDB_ROOT: {
				description: chalk.magenta(`[HDB_ROOT] Please enter the destination for HarperDB`),
				message: 'HDB_ROOT cannot contain /',
				default: env.getHdbBasePath() ? env.getHdbBasePath() : process.env['HOME'] + '/hdb',
				ask: function () {
					// only ask for HDB_ROOT if it is not defined.
					if (env.getHdbBasePath()) {
						console.log(`Using previous install path: ${env.getHdbBasePath()}`);
						return false;
					}
					return true;
				},
				required: false,
			},
			NODE_NAME: {
				description: chalk.magenta(`[NODE_NAME] Please enter a unique name for this node`),
				default: hri.random(),
				required: false,
			},
			SERVER_PORT: {
				pattern: /^([0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/,
				description: chalk.magenta(`[SERVER_PORT] Please enter a server listening port for HarperDB`),
				message: 'Invalid port.',
				default: 9925,
				required: false,
			},
			CLUSTERING_PORT: {
				pattern: /^([0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/,
				description: chalk.magenta(`[CLUSTERING_PORT] Please enter a listening port for Clustering`),
				message: 'Invalid port.',
				default: 1111,
				required: false,
			},
			HDB_ADMIN_USERNAME: {
				description: chalk.magenta('[HDB_ADMIN_USERNAME] Please enter a username for the HDB_ADMIN'),
				default: 'HDB_ADMIN',
				required: true,
			},
			HDB_ADMIN_PASSWORD: {
				description: chalk.magenta('[HDB_ADMIN_PASSWORD] Please enter a password for the HDB_ADMIN'),
				hidden: true,
				required: true,
			},
			CLUSTERING_USER: {
				description: chalk.magenta('[CLUSTERING_USER] Please enter a username for the CLUSTERING USER'),
				default: 'CLUSTER_USER',
				message: 'Specified username is invalid or already in use.',
				required: true,
				// check clustering user name not the same as admin user name
				conform: function (username) {
					return username !== admin_username;
				},
			},
			CLUSTERING_PASSWORD: {
				description: chalk.magenta('[CLUSTERING_PASSWORD] Please enter a password for the CLUSTERING USER'),
				hidden: true,
				required: true,
			},
		},
	};
	//Assign any results from the install wizard to ARGS (which holds results from command line, environment)
	let ARGS = assignCMDENVVariables(['CLUSTERING']);
	if (ARGS.CLUSTERING === undefined) {
		delete install_schema.properties.NODE_NAME;
		delete install_schema.properties.CLUSTERING_PASSWORD;
		delete install_schema.properties.CLUSTERING_PORT;
		delete install_schema.properties.CLUSTERING_USER;
	}

	console.log(chalk.magenta('' + fs.readFileSync(path.join(__dirname, './ascii_logo.txt'))));
	console.log(chalk.magenta('                    Installer'));

	prompt.get(install_schema, function (prompt_err, result) {
		wizard_result = result;
		//Support the tilde command for HOME.
		if (wizard_result.HDB_ROOT.indexOf('~') > -1) {
			let home = process.env['HOME'];
			if (home !== undefined) {
				// Replaces ~ with env home and removes any tabs created from user hoping to use autocomplete.
				let replacement = wizard_result.HDB_ROOT.replace('~', process.env['HOME']).replace(new RegExp('\t', 'g'), '');
				if (replacement && replacement.length > 0) {
					wizard_result.HDB_ROOT = replacement;
				}
			} else {
				return callback('~ was specified in the path, but the HOME environment variable is not defined.');
			}
		}

		if (!check_install_path) {
			// Only if reinstall not detected by presence of hdb_boot_props file.  Dig around the provided path to see if an existing install is already there.
			if (
				!fs.existsSync(wizard_result.HDB_ROOT) ||
				!fs.existsSync(wizard_result.HDB_ROOT + '/config/settings.js') ||
				!fs.existsSync(wizard_result.HDB_ROOT + '/schema/system')
			) {
				return callback(prompt_err, wizard_result.HDB_ROOT);
			}
			// we have an existing install, prompt for reinstall.
			promptForReinstall((reinstall_err, reinstall) => {
				//the process will exit in `promptForReinstall` if they choose not to proceed
				return callback(null, wizard_result.HDB_ROOT);
			});
		} else {
			return callback(null, wizard_result.HDB_ROOT);
		}
	});
}

function createSuperUser(callback) {
	hdb_logger.info('Creating Super user.');
	let role = {
		role: 'super_user',
		permission: {
			super_user: true,
		},
	};

	let user = {
		username: wizard_result.HDB_ADMIN_USERNAME.toString(),
		password: wizard_result.HDB_ADMIN_PASSWORD.toString(),
		active: true,
	};

	createAdminUser(role, user, (err) => {
		if (err) {
			return callback(err);
		}

		callback();
	});
}

function createClusterUser(callback) {
	hdb_logger.info('Creating Cluster user.');
	let role = {
		role: 'cluster_user',
		permission: {
			cluster_user: true,
		},
	};

	let user = undefined;
	if (wizard_result.CLUSTERING_USER !== undefined && wizard_result.CLUSTERING_PASSWORD !== undefined) {
		user = {
			username: wizard_result.CLUSTERING_USER.toString(),
			password: wizard_result.CLUSTERING_PASSWORD.toString(),
			active: true,
		};
	}

	createAdminUser(role, user, (err) => {
		if (err) {
			return callback(err);
		}

		callback();
	});
}

function createAdminUser(role, admin_user, callback) {
	hdb_logger.info('Creating admin user.');
	// These need to be defined here since they use the hdb_boot_properties file, but it has not yet been created
	// in the installer.
	const user_ops = require('../../security/user');
	const role_ops = require('../../security/role');
	const util = require('util');
	const cb_role_add_role = util.callbackify(role_ops.addRole);
	const cb_user_add_user = util.callbackify(user_ops.addUser);

	schema.setSchemaDataToGlobal(() => {
		cb_role_add_role(role, (err, res) => {
			if (err) {
				hdb_logger.error('role failed to create ' + err);
				console.log('There was a problem creating the default role.  Please check the install log for details.');
				return callback(err);
			}

			if (admin_user === undefined) {
				return callback(null);
			}

			admin_user.role = res.role;

			cb_user_add_user(admin_user, (add_user_err) => {
				if (add_user_err) {
					hdb_logger.error('user creation error' + add_user_err);
					console.error('There was a problem creating the admin user.  Please check the install log for details.');
					return callback(add_user_err);
				}
				return callback(null);
			});
		});
	});
}

function createSettingsFile(mount_status, callback) {
	console.log('Starting HarperDB Install...');
	hdb_logger.info('Creating settings file.');
	if (mount_status !== 'complete') {
		hdb_logger.error('mount failed.');
		return callback('mount failed');
	}

	let settings_path = `${wizard_result.HDB_ROOT}/${hdb_terms.HDB_CONFIG_FILE}`;
	createBootPropertiesFile(settings_path, (err) => {
		hdb_logger.info('info', `creating settings file....`);
		if (err) {
			hdb_logger.info('info', 'boot properties error' + err);
			console.error('There was a problem creating the boot file.  Please check the install log for details.');
			return callback(err);
		}

		const ARGS = assignCMDENVVariables(Object.keys(hdb_terms.CONFIG_PARAM_MAP), true);
		Object.assign(ARGS, wizard_result);

		try {
			// Create the HarperDB config file.
			config_utils.createConfigFile(ARGS);
			env.initSync();
		} catch (config_err) {
			rollbackInstall(config_err, ARGS);
		}

		return callback(null);
	});
}

/**
 * Used to remove the .harperdb and hdb folder if there is an error with creating the config file.
 * @param err_msg
 * @param install_args
 */
function rollbackInstall(err_msg, install_args) {
	console.error(err_msg);
	console.error(ABORT_MSG);

	const harperdb_boot_folder = path.resolve(env.get(env.BOOT_PROPS_FILE_PATH), '../');
	if (harperdb_boot_folder) {
		fs.removeSync(harperdb_boot_folder);
	}

	const hdb_root = env.getHdbBasePath();
	if (hdb_root) {
		fs.removeSync(hdb_root);
	}

	process.exit(1);
}

function generateKeys(callback) {
	hdb_logger.info('Generating keys files.');
	let pki = forge.pki;
	let keys = pki.rsa.generateKeyPair(KEY_PAIR_BITS);
	let cert = pki.createCertificate();
	cert.publicKey = keys.publicKey;
	cert.serialNumber = '01';
	cert.validity.notBefore = new Date();
	cert.validity.notAfter = new Date();
	cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
	let attrs = [
		{
			name: 'commonName',
			value: 'harperdb.io',
		},
		{
			name: 'countryName',
			value: 'US',
		},
		{
			shortName: 'ST',
			value: 'Colorado',
		},
		{
			name: 'localityName',
			value: 'Denver',
		},
		{
			name: 'organizationName',
			value: 'HarperDB, Inc',
		},
		{
			shortName: 'OU',
			value: 'HDB',
		},
	];
	cert.setSubject(attrs);
	cert.setIssuer(attrs);
	cert.setExtensions([
		{
			name: 'basicConstraints',
			cA: true,
			id: 'hdb_1.0',
		},
		{
			name: 'keyUsage',
			keyCertSign: true,
			digitalSignature: true,
			nonRepudiation: true,
			keyEncipherment: true,
			dataEncipherment: true,
		},
		{
			name: 'extKeyUsage',
			serverAuth: true,
			clientAuth: true,
			codeSigning: true,
			emailProtection: true,
			timeStamping: true,
		},
		{
			name: 'nsCertType',
			client: true,
			server: true,
			email: true,
			objsign: true,
			sslCA: true,
			emailCA: true,
			objCA: true,
		},
		{
			name: 'subjectAltName',
			altNames: [
				{
					type: 6, // URI
					value: 'http://example.org/webid#me',
				},
				{
					type: 7, // IP
					ip: '127.0.0.1',
				},
			],
		},
		{
			name: 'subjectKeyIdentifier',
		},
	]);

	cert.sign(keys.privateKey);

	// convert a Forge certificate to PEM
	fs.writeFile(env.get('CERTIFICATE'), pki.certificateToPem(cert), function (err) {
		if (err) {
			hdb_logger.error(err);
			console.error('There was a problem creating the PEM file.  Please check the install log for details.');
			return callback(err);
		}
		fs.writeFile(env.get('PRIVATE_KEY'), forge.pki.privateKeyToPem(keys.privateKey), function (fs_write_file_err) {
			if (fs_write_file_err) {
				hdb_logger.error(fs_write_file_err);
				console.error('There was a problem creating the private key file.  Please check the install log for details.');
				return callback(fs_write_file_err);
			}
			return callback();
		});
	});
}

function createBootPropertiesFile(settings_path, callback) {
	hdb_logger.info('info', 'creating boot file');
	if (!settings_path) {
		hdb_logger.error('info', 'missing settings path');
		return callback('missing setings');
	}
	let install_user = undefined;
	try {
		install_user = os.userInfo().username;
	} catch (err) {
		// this could fail on android, try env variables
		install_user =
			process.env.USERNAME || process.env.USER || process.env.LOGNAME || process.env.LNAME || process.env.SUDO_USER;
	}
	if (!install_user) {
		let msg =
			'Could not determine current username in this environment.  Please set the USERNAME environment variable in your OS and try install again.';
		console.error(msg);
		hdb_logger.error(msg);
		return callback(msg, null);
	}
	let boot_props_value = `settings_path = ${settings_path}
    install_user = ${install_user}`;

	let home_dir = comm.getHomeDir();
	let home_dir_path = path.join(home_dir, hdb_terms.HDB_HOME_DIR_NAME);
	let home_dir_keys_dir_path = path.join(home_dir_path, hdb_terms.LICENSE_KEY_DIR_NAME);
	try {
		fs.mkdirpSync(home_dir_path, { mode: hdb_terms.HDB_FILE_PERMISSIONS });
		fs.mkdirpSync(home_dir_keys_dir_path, { mode: hdb_terms.HDB_FILE_PERMISSIONS });
	} catch (err) {
		console.log(
			`Could not make settings directory ${hdb_terms.HDB_HOME_DIR_NAME} in home directory.  Please check your permissions and try again.`
		);
	}

	let props_file_path = path.join(home_dir_path, hdb_terms.BOOT_PROPS_FILE_NAME);
	fs.writeFile(props_file_path, boot_props_value, function (err) {
		if (err) {
			hdb_logger.error('info', `Bootloader error ${err}`);
			console.error('There was a problem creating the boot file.  Please check the install log for details.');
			return callback(err);
		}
		hdb_logger.info('info', `props path ${props_file_path}`);
		env.setProperty(hdb_terms.HDB_SETTINGS_NAMES.INSTALL_USER, `${install_user}`);
		env.setProperty(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, settings_path);
		env.setProperty(env.BOOT_PROPS_FILE_PATH, props_file_path);
		return callback(null, 'success');
	});
}
