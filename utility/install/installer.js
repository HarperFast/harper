/**
 * INSTALLER.JS
 *
 * This module is used to install HarperDB.  It is meant to be a self contained module which is why it configures
 * it's own winston instance.
 */

const prompt = require('prompt');
const spawn = require('child_process').spawn;
const path = require('path');
const mount = require('./../mount_hdb');
const fs = require('fs-extra');
const colors = require("colors/safe");
const winston = require('winston');
const async = require('async');
const optimist = require('optimist');
const forge = require('node-forge');
const terms_address = 'http://legal.harperdb.io/Software+License+Subscription+Agreement+110317.pdf';
const env = require('../../utility/environment/environmentManager');
const os = require('os');
const schema = require('../../utility/globalSchema');
const user_schema = require('../../utility/user_schema');
const comm = require('../common_utils');
const hdb_terms = require('../hdbTerms');
const crypto = require('crypto');

const LOG_LOCATION = ('../install_log.log');
module.exports = {
    install: run_install
};

let wizard_result;
let existing_users = [];
let keep_data = false;
let check_install_path = false;
const NODE_NAME_BYTE_LENGTH = 4;
const KEY_PAIR_BITS = 2048;

env.initSync();

/**
 * Stars the install process by first checking for an existing installation, then firing the steps to complete the install.
 * Information required to complete the install is root path, desired harper port, TCP port, username, and password.
 * @param callback
 */
function run_install(callback) {
    winston.configure({
        transports: [
            new (winston.transports.File)({
                filename: LOG_LOCATION,
                level: 'verbose',
                handleExceptions: true,
                prettyPrint: true
            })
        ],
        exitOnError: false
    });

    if (comm.isEmptyOrZeroLength(os.userInfo().uid)) {
        let msg = `Installing user: ${os.userInfo().username} has no pid.  Please install with a properly created user. Cancelling install.`;
        winston.error(msg);
        console.log(msg);
        return callback(msg, null);
    }

    prompt.override = optimist.argv;
    prompt.start();
    winston.info('starting install');
    checkInstall(function (err, keepGoing) {
        if (keepGoing) {
            async.waterfall([
                termsAgreement,
                wizard,
                async.apply(mount, winston),
                createSettingsFile,
                createAdminUser,
                generateKeys,
                () => {
                    console.log("HarperDB Installation was successful");
                    winston.info("Installation Successful");
                    process.exit(0);
                }
            ], function (err) {
                if (err) {
                    return callback(err, null);
                }
                return callback(null, null);
            });
        }
    });
}

/**
 * Prompts the user to accept the linked Terms & Conditions.  If the user does not agree, install process is killed.
 * @param {*} callback 
 */
function termsAgreement(callback) {
    winston.info('Asking for terms agreement.');
    prompt.message = ``;
    let terms_schema = {
        properties: {
            TC_AGREEMENT: {
                message: colors.magenta(`I Agree to the HarperDB Terms and Conditions. (yes/no).  The Terms and Conditions can 
                be found at ${terms_address}`),
                validator: /y[es]*|n[o]?/,
                warning: 'Must respond yes or no',
                default: 'yes'
            }
        }
    };
    prompt.get(terms_schema, function (err, result) {
        if (err) { return callback(err); }
        if (result.TC_AGREEMENT === 'yes' || result.TC_AGREEMENT === 'y') {
            return callback(null, true);
        }
        winston.error('Terms and Conditions agreement was refused.');
        return callback('REFUSED', false);
    });
}

/**
 * Checks for the presence of an existing install by finding the hdb_boot props file.  If the file is found, the user
 * is prompted for a decision to reinstall over the existing installation.
 * @param callback
 */
function checkInstall(callback) {
    winston.info('Checking for previous installation.');
    try {
        let boot_prop_path = comm.getPropsFilePath();
        fs.accessSync(boot_prop_path, fs.constants.F_OK | fs.constants.R_OK);
        env.setPropsFilePath(boot_prop_path);
        env.initSync();
        if (!env.get('HDB_ROOT')) {
            return callback(null, true);
        }
        promptForReinstall((err, result) => callback(err, result));
    } catch(err) {
        return callback(err, true);
    }
}

function promptForReinstall(callback) {
    winston.info('Previous install detected, asking for reinstall.');
    let reinstall_schema = {
        properties: {
            REINSTALL: {
                message: colors.red('It appears HarperDB is already installed.  Enter \'y/yes\'to reinstall. (yes/no)'),
                validator: /y[es]*|n[o]?/,
                warning: 'Must respond yes or no',
                default: 'no'
            }
        }
    };
    let overwrite_schema = {
        properties: {
            KEEP_DATA: {
                message: colors.red('Would you like to keep existing data?  You will still need to create a new admin user. (yes/no)'),
                validator: /y[es]*|n[o]?/,
                warning: 'Must respond yes or no',
                default: 'no'
            }
        }
    };

    prompt.get(reinstall_schema, function (err, reinstall_result) {
        if (err) { return callback(err); }

        if (reinstall_result.REINSTALL === 'yes' || reinstall_result.REINSTALL === 'y') {
            check_install_path = true;
            prompt.get(overwrite_schema, function (err, overwrite_result) {
                if (overwrite_result.KEEP_DATA === 'no' || overwrite_result.KEEP_DATA === 'n' ) {
                    // don't keep data, tear it all out.
                    fs.remove(env.get('HDB_ROOT'), function (err) {
                        if (err) {
                            winston.error(err);
                            console.log('There was a problem removing the existing installation.  Please check the install log for details.');
                            return callback(err);
                        }

                        fs.unlink(env.BOOT_PROPS_FILE_PATH, function (err) {
                            if (err) {
                                winston.error(err);
                                console.log('There was a problem removing the existing installation.  Please check the install log for details.');
                                return callback(err);
                            }
                            return callback(null, true);
                        });
                    });
                } else {
                    // keep data
                    keep_data = true;
                    // we need the global.hdb_schema set so we can find existing roles when we add the new user.
                    prepForReinstall(() => callback(null, true));
                }
            });
        } else {
            return callback(null, false);
        }
    });
}

/**
 * Prepare all data needed to perform a reinstall.
 * @param callback
 * @returns {*}
 */
function prepForReinstall(callback) {
    winston.info('Preparing for reinstall.');
    if (!global.hdb_users || !global.hdb_schema) {
        user_schema.setUsersToGlobal((err) => {
            if (err) {
                winston.error(err);
                return callback(err, null);
            }
            for (let i = 0; i < global.hdb_users.length; i++) {
                existing_users.push(global.hdb_users[i].username);
            }
            schema.setSchemaDataToGlobal(() => callback(null, true));
        });
    } else {
        return callback(null, null);
    }
}

/**
 * The install wizard will guide the user through the required data needed for the install.
 * @param err - Errors from the previous (Terms and Conditions) waterfall function.
 * @param callback
 */
function wizard(err, callback) {
    prompt.message = ``;
    winston.info('Starting install wizard');
    let install_schema = {
        properties: {
            HDB_ROOT: {
                description: colors.magenta(`[HDB_ROOT] Please enter the destination for HarperDB`),
                message: 'HDB_ROOT cannot contain /',
                default: (env.getHdbBasePath() ? env.getHdbBasePath() : process.env['HOME'] + '/hdb'),
                ask: function() {
                    // only ask for HDB_ROOT if it is not defined.
                    if (env.getHdbBasePath()) {
                        console.log(`Using previous install path: ${env.getHdbBasePath()}`);
                        return false;
                    }
                    return true;
                },
                required: false
            },
            HTTP_PORT: {
                pattern: /^([0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/,
                description: colors.magenta(`[HTTP_PORT] Please enter an HTTP listening port for HarperDB`),
                message: 'Invalid port.',
                default: 9925,
                required: false
            },
            HTTPS_PORT: {
                pattern: /^([0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/,
                description: colors.magenta(`[HTTPS_PORT] Please enter an HTTPS listening port for HarperDB`),
                message: 'Invalid port.',
                default: 31283,
                required: false
            },
            HDB_ADMIN_USERNAME: {
                description: colors.magenta('[HDB_ADMIN_USERNAME] Please enter a username for the HDB_ADMIN'),
                default: 'HDB_ADMIN',
                message: 'Specified username is invalid or already in use.',
                required: true,
                // check against the previously built list of existing usernames.
                conform: function (username) {
                    if (!keep_data) {
                        return true;
                    }
                    for (let i = 0; i < existing_users.length; i++) {
                        if (username === existing_users[i]) {
                            return false;
                        }
                    }
                    return true;
                }
            },
            HDB_ADMIN_PASSWORD: {
                description: colors.magenta('[HDB_ADMIN_PASSWORD] Please enter a password for the HDB_ADMIN'),
                hidden: true,
                required: true
            }
        }
    };

    console.log(colors.magenta('' + fs.readFileSync(path.join(__dirname, './ascii_logo.txt'))));
    console.log(colors.magenta('                    Installer'));

    prompt.get(install_schema, function (err, result) {
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
            if (!fs.existsSync(wizard_result.HDB_ROOT) ||
                !fs.existsSync(wizard_result.HDB_ROOT + '/config/settings.js') ||
                !fs.existsSync(wizard_result.HDB_ROOT + '/schema/system')) {
                return callback(err, wizard_result.HDB_ROOT);
            }
            // we have an existing install, prompt for reinstall.
            promptForReinstall((err, reinstall) => {
                if (reinstall) {
                    env.setPropsFilePath(wizard_result.HDB_ROOT + '/config/settings.js');
                    env.initSync();
                    prepForReinstall((err) => {
                        winston.error(err);
                        return callback(null, wizard_result.HDB_ROOT);
                    });
                } else {
                    return callback(null, wizard_result.HDB_ROOT);
                }
            });
        } else {
            return callback(null, wizard_result.HDB_ROOT);
        }
    });
}

function createAdminUser(callback) {
    winston.info('Creating admin user.');
    // These need to be defined here since they use the hdb_boot_properties file, but it has not yet been created
    // in the installer.
    const user_ops = require('../../security/user');
    const role_ops = require('../../security/role');
    const util = require('util');
    const cb_role_add_role = util.callbackify(role_ops.addRole);
    const cb_role_list_role = util.callbackify(role_ops.listRoles);
    const cb_user_add_user = util.callbackify(user_ops.addUser);
    let role = {};
    role.role = 'super_user';
    role.permission = {};
    role.permission.super_user = true;

    // Look for existing role if this is a reinstall
    if (keep_data) {
        // 1.  Get list of all roles that are su
        // 2.  IFF > 1, Show list to user and require selection of primary su role

        cb_role_list_role((null), (err, res) => {
            winston.info(`found ${res.length} existing roles.`);
            let role_list = 'Please select the number assigned to the role that should be assigned to the new user.';

            if (res && res.length > 1) {
                for (let i = 0; i < res.length; i++) {
                    // It would be confusing to offer 0 as a number for the user to select, so offset by 1 to start at 1.
                    role_list += `\n ${i + 1}. ${res[i].role}`;
                }

                let role_schema = {
                    properties: {
                        ROLE: {
                            message: colors.red(role_list),
                            type: 'number',
                            minimum: 1,
                            maximum: res.length,
                            warning: 'Must select the number corresponding to the desired role.',
                            default: '1'
                        }
                    }
                };

                prompt.get(role_schema, function (err, selected_role) {
                    let admin_user = {};
                    admin_user.username = wizard_result.HDB_ADMIN_USERNAME;
                    admin_user.password = wizard_result.HDB_ADMIN_PASSWORD;
                    // account for the offset
                    admin_user.role = res[selected_role.ROLE - 1].id;
                    admin_user.active = true;

                    cb_user_add_user(admin_user, (err) => {
                        if (err) {
                            winston.error('user creation error' + err);
                            console.error('There was a problem creating the admin user.  Please check the install log for details.');
                            return callback(err);
                        }
                        return callback(null);
                    });
                });

            } else {
                let admin_user = {};
                admin_user.username = wizard_result.HDB_ADMIN_USERNAME;
                admin_user.password = wizard_result.HDB_ADMIN_PASSWORD;
                admin_user.role = res[0].id;
                admin_user.active = true;

                cb_user_add_user(admin_user, (err) => {
                    if (err) {
                        winston.error('user creation error' + err);
                        console.error('There was a problem creating the admin user.  Please check the install log for details.');
                        return callback(err);
                    }
                    return callback(null);
                });
            }
        });

    } else {
        cb_role_add_role(role, (err, res) => {
            if (err) {
                winston.error('role failed to create ' + err);
                console.log('There was a problem creating the default role.  Please check the install log for details.');
                return callback(err);
            }

            let admin_user = {};
            admin_user.username = wizard_result.HDB_ADMIN_USERNAME;
            admin_user.password = wizard_result.HDB_ADMIN_PASSWORD;
            admin_user.role = res.id;
            admin_user.active = true;

            cb_user_add_user(admin_user, (err) => {
                if (err) {
                    winston.error('user creation error' + err);
                    console.error('There was a problem creating the admin user.  Please check the install log for details.');
                    return callback(err);
                }
                return callback(null);
            });
        });
    }
}

function createSettingsFile(mount_status, callback) {
    console.log('Starting HarperDB Install...');
    winston.info('Creating settings file.');
    if (mount_status !== 'complete') {
        winston.error('mount failed.');
        return callback('mount failed');
    }

    if (keep_data) {
        console.log('Existing settings.js file will be moved to settings.js.backup.  Remember to update the new settings file with your old settings.');
        winston.info('Existing settings.js file will be moved to settings.js.backup.  Remember to update the new settings file with your old settings.');
    }
    let settings_path = `${wizard_result.HDB_ROOT}/config/settings.js`;
    createBootPropertiesFile(settings_path, (err) => {
        // copy settings file to backup.
        if (keep_data) {
            if (fs.existsSync(settings_path)) {
                try {
                    fs.copySync(settings_path, settings_path+'.back');
                } catch(err) {
                    console.log(`There was a problem backing up current settings.js file.  Please check the logs.  Exiting.`);
                    winston.fatal(err);
                    throw err;
                }
            }
        }

        winston.info('info', `creating settings file....`);
        if (err) {
            winston.info('info', 'boot properties error' + err);
            console.error('There was a problem creating the boot file.  Please check the install log for details.');
            return callback(err);
        }
        let num_cores = 4;
        try {
            num_cores = os.cpus().length;
            winston.info(`Detected ${num_cores} on this machine, defaulting MAX_HDB_PROCESSES to that.  This can be changed later in the settings.js file.`);
        } catch (err) {
            //No-op, should only get here in the case of android.  Defaulted to 4.
        }
        const path = require('path');
        let node_name = null;
        try {
            node_name = crypto.randomBytes(NODE_NAME_BYTE_LENGTH).toString('hex');
        } catch(err) {
            winston.error('There was an error generating a random name for node name.  Defaulting to some_node.');
            node_name = 'some_node';
        }
        let hdb_props_value = `   ;Settings for the HarperDB process.\n` +
            `\n` +
            `   ;The directory harperdb has been installed in.\n` +
            `PROJECT_DIR = ${path.resolve(__dirname,'../../')}\n` +
            `   ;The directory selected during install where the database files reside.\n` +
            `HDB_ROOT = ${wizard_result.HDB_ROOT}\n` +
            `   ;The port the HarperDB REST interface will listen on.\n` +
            `HTTP_PORT = ${wizard_result.HTTP_PORT}\n` +
            `   ;If HTTPS is enabled, the port the HarperDB REST interface will listen on.\n` +
            `HTTPS_PORT = ${wizard_result.HTTPS_PORT}\n` +
            `   ;The path to the SSL certificate used when running with HTTPS enabled.\n` +
            `CERTIFICATE = ${wizard_result.HDB_ROOT}/keys/certificate.pem\n` +
            `   ;The path to the SSL private key used when running with HTTPS enabled.\n` +
            `PRIVATE_KEY = ${wizard_result.HDB_ROOT}/keys/privateKey.pem\n` +
            `   ;Set to true to enable HTTPS on the HarperDB REST endpoint.  Requires a valid certificate and key.\n` +
            `HTTPS_ON = FALSE\n` +
            `   ;Set to true to have HarperDB run using standard HTTP.\n` +
            `HTTP_ON = TRUE \n` +
            `   ;Set to true to enable Cross Origin Resource Sharing, which allows requests across a domain.\n` +
            `CORS_ON = TRUE\n` +
            `   ;Allows for setting allowable domains with CORS. Comma separated list.\n` +
            `CORS_WHITELIST =\n` +
            `   ;Length of time in milliseconds after which a request will timeout.  Defaults to 120,000 ms (2 minutes).\n` +
            `SERVER_TIMEOUT_MS = 120000\n` +
            `   ;Set to control amount of logging generated.  Accepted levels are trace, debug, warn, error, fatal.\n` +
            `LOG_LEVEL = warn\n` +
            `   ;Setting LOGGER to 1 uses the WINSTON logger.\n` +
            `   ; 2 Uses the more performant PINO logger.\n` +
            `LOGGER = 1\n` +
            `   ;The path where log files will be written.\n` +
            `LOG_PATH = ${wizard_result.HDB_ROOT}/log/hdb_log.log\n` +
            `   ;The environment used by NodeJS.  Setting to production will be the most performant, settings to development will generate more logging.\n` +
            `NODE_ENV = production\n` +
            `   ;This allows self signed certificates to be used in clustering.  This is a security risk\n` +
            `   ;as clustering will not validate the cert, so should only be used internally.\n` +
            `   ;The HDB install creates a self signed certificate, if you use that cert this must be set to true.\n` +
            `ALLOW_SELF_SIGNED_SSL_CERTS = false\n` +
            `   ;Set the max number of processes HarperDB will start.  This can also be limited by number of cores and licenses.\n` +
            `MAX_HDB_PROCESSES = ${num_cores}\n` +
            `   ;Set to true to enable clustering.  Requires a valid enterprise license.\n` +
            `CLUSTERING = false\n` +
            `   ;The port that will be used for HarperDB clustering.\n` +
            `CLUSTERING_PORT = 12345\n` +
            `   ;The name of this node in your HarperDB cluster topology.  This must be a value unique from the rest of your cluster node names.\n` +
            `NODE_NAME=${node_name}\n`;

        winston.info('info', `hdb_props_value ${JSON.stringify(hdb_props_value)}`);
        winston.info('info', `settings path: ${env.get('settings_path')}`);
        try {
            fs.writeFile(env.get('settings_path'), hdb_props_value, function (err) {
                if (err) {
                    console.error('There was a problem writing the settings file.  Please check the install log for details.');
                    winston.error(err);
                    return callback(err);
                }
                // load props
                env.initSync();
                return callback(null);
            });
        } catch (e) {
            winston.info(e);
        }
    });
}

function generateKeys(callback) {
    winston.info('Generating keys files.');
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
            value: 'harperdb.io'
        },
        {
            name: 'countryName',
            value: 'US'
        },
        {
            shortName: 'ST',
            value: 'Colorado'
        },
        {
            name: 'localityName',
            value: 'Denver'
        },
        {
            name: 'organizationName',
            value: 'HarperDB, Inc'
        },
        {
            shortName: 'OU',
            value: 'HDB'
        }
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
        {
            name: 'basicConstraints',
            cA: true,
            id: 'hdb_1.0'
        },
        {
            name: 'keyUsage',
            keyCertSign: true,
            digitalSignature: true,
            nonRepudiation: true,
            keyEncipherment: true,
            dataEncipherment: true
        },
        {
            name: 'extKeyUsage',
            serverAuth: true,
            clientAuth: true,
            codeSigning: true,
            emailProtection: true,
            timeStamping: true
        },
        {
            name: 'nsCertType',
            client: true,
            server: true,
            email: true,
            objsign: true,
            sslCA: true,
            emailCA: true,
            objCA: true
        },
        {
            name: 'subjectAltName',
            altNames: [
                {
                    type: 6, // URI
                    value: 'http://example.org/webid#me'
                },
                {
                    type: 7, // IP
                    ip: '127.0.0.1'
                }
            ]
        },
        {
            name: 'subjectKeyIdentifier'
        }
    ]);

    cert.sign(keys.privateKey);

    // convert a Forge certificate to PEM
    fs.writeFile(env.get('CERTIFICATE'), pki.certificateToPem(cert), function (err) {
        if (err) {
            winston.error(err);
            console.error('There was a problem creating the PEM file.  Please check the install log for details.');
            return callback(err);
        }
        fs.writeFile(env.get('PRIVATE_KEY'), forge.pki.privateKeyToPem(keys.privateKey), function (err) {
            if (err) {
                winston.error(err);
                console.error('There was a problem creating the private key file.  Please check the install log for details.');
                return callback(err);
            }
            return callback();
        });
    });
}


function setupService(callback) {
    fs.readFile(`./utility/install/harperdb.service`, 'utf8', function (err, data) {
        let fileData = data.replace('{{project_dir}}', `${env.get('PROJECT_DIR')}`).replace('{{hdb_directory}}',
            env.get('HDB_ROOT'));
        fs.writeFile('/etc/systemd/system/harperdb.service', fileData, function (err) {

            if (err) {
                winston.info('error', `Service Setup Error ${err}`);
                console.error('There was a problem setting up the service.  Please check the install log for details.');
                return callback(err);
            }

            let terminal = spawn('bash');
            terminal.stderr.on('data', function () {
            });

            terminal.stdin.write(`sudo systemctl daemon-reload &`);
            terminal.stdin.end();
            return callback(null, 'success');
        });
    });
}

function createBootPropertiesFile(settings_path, callback) {
    winston.info('info', 'creating boot file');
    if (!settings_path) {
        winston.error('info', 'missing settings path');
        return callback('missing setings');
    }
    let install_user = undefined;
    try {
        install_user = os.userInfo().username;
    } catch(err) {
        // this could fail on android, try env variables
        install_user = process.env.USERNAME ||
            process.env.USER ||
            process.env.LOGNAME ||
            process.env.LNAME ||
            process.env.SUDO_USER;
    }
    if(!install_user) {
        let msg = 'Could not determine current username in this environment.  Please set the USERNAME environment variable in your OS and try install again.';
        console.error(msg);
        winston.error(msg);
        return callback(msg, null);
    }
    let boot_props_value = `settings_path = ${settings_path}
    install_user = ${install_user}`;

    let home_dir = comm.getHomeDir();
    let home_dir_path = path.join(home_dir, hdb_terms.HDB_HOME_DIR_NAME);
    try {
        fs.mkdirpSync(home_dir_path);
    } catch(err) {
        console.log(`Could not make settings directory ${hdb_terms.HDB_HOME_DIR_NAME} in home directory.  Please check your permissions and try again.`);
    }

    let props_file_path = path.join(home_dir_path, hdb_terms.BOOT_PROPS_FILE_NAME);
    fs.writeFile(props_file_path, boot_props_value, function (err) {
        if (err) {
            winston.error('info', `Bootloader error ${err}`);
            console.error('There was a problem creating the boot file.  Please check the install log for details.');
            return callback(err);
        }
        winston.info('info', `props path ${props_file_path}`);
        env.setProperty(hdb_terms.HDB_SETTINGS_NAMES.INSTALL_USER, `${install_user}`);
        env.setProperty(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, settings_path);
        return callback(null, 'success');
    });
}
