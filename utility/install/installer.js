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
const minimist = require('minimist');
const forge = require('node-forge');
const hri = require('human-readable-ids').hri;
const terms_address = 'https://harperdb.io/legal/software-license-subscription-agreement';
const env = require('../../utility/environment/environmentManager');
const os = require('os');
const comm = require('../common_utils');
const hdb_terms = require('../hdbTerms');
const hdbInfoController = require('../../data_layer/hdbInfoController');
const version = require('../../bin/version');
const LOG_LOCATION = ('../install_log.log');
const check_jwt_tokens = require('./checkJWTTokensExist');

module.exports = {
    install: run_install
};

// These require statements were moved below the module.exports to resolve circular dependencies within the harperBridge module.
const schema = require('../../utility/globalSchema');

let wizard_result;
let check_install_path = false;
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
    prompt.override = minimist(process.argv);
    prompt.start();
    winston.info('starting install');
    checkInstall(function (err, keepGoing) {
        if (keepGoing) {
            async.waterfall([
                termsAgreement,
                wizard,
                async.apply(mount, winston),
                createSettingsFile,
                createSuperUser,
                createClusterUser,
                generateKeys,
                insertHdbInfo,
                () => {
                    check_jwt_tokens();

                    console.log('HarperDB Installation was successful');
                    winston.info('Installation Successful');
                    process.exit(0);
                }
            ], function (install_err) {
                if (install_err) {
                    return callback(install_err, null);
                }
                return callback(null, null);
            });
        } else {
            console.log('Exiting installer');
            process.exit(0);
        }
    });
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
        hdbInfoController.insertHdbInstallInfo(vers)
            .then(res => {
                winston.info('Product version info was properly inserted');
                return callback(null, res);
            })
            .catch(err => {
                winston.error('Error inserting product version info');
                winston.error(err);
                return callback(err, null);
            });
    } else {
        const err_msg = 'The version is missing/removed from package.json';
        winston.error(err_msg);
        console.log(err_msg);
        return callback(err_msg, null);
    }
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
                message: colors.red(`It appears HarperDB version ${version.version()} is already installed.  Enter \'y/yes\'to reinstall. (yes/no)`),
                validator: /y[es]*|n[o]?/,
                warning: 'Must respond yes or no',
                default: 'no'
            }
        }
    };
    let overwrite_schema = {
        properties: {
            KEEP_DATA: {
                message: colors.red('Would you like to keep existing data?  (yes/no)'),
                validator: /y[es]*|n[o]?/,
                warning: 'Must respond yes or no',
                required: true
            }
        }
    };

    prompt.get(reinstall_schema, function (err, reinstall_result) {
        if (err) { return callback(err); }

        if (reinstall_result.REINSTALL === 'yes' || reinstall_result.REINSTALL === 'y') {
            check_install_path = true;
            prompt.get(overwrite_schema, function (prompt_err, overwrite_result) {
                if (overwrite_result.KEEP_DATA === 'no' || overwrite_result.KEEP_DATA === 'n') {
                    // don't keep data, tear it all out.
                    fs.remove(env.get('HDB_ROOT'), function (fs_remove_err) {
                        if (fs_remove_err) {
                            winston.error(fs_remove_err);
                            console.log('There was a problem removing the existing installation.  Please check the install log for details.');
                            return callback(fs_remove_err);
                        }

                        fs.unlink(env.BOOT_PROPS_FILE_PATH, function (fs_unlink_err) {
                            if (fs_unlink_err) {
                                winston.error(fs_unlink_err);
                                console.log('There was a problem removing the existing installation.  Please check the install log for details.');
                                return callback(fs_unlink_err);
                            }
                            return callback(null, true);
                        });
                    });
                } else {
                    // keep data - this means they should be using the upgrade command
                    const upgrade_msg = "Please use `harperdb upgrade` to update your existing instance of HDB. Exiting install...";
                    console.log(`${os.EOL}` + colors.magenta.bold(upgrade_msg) + `${os.EOL}`);
                    process.exit(0);
                }
            });
        } else {
            return callback(null, false);
        }
    });
}

/**
 * The install wizard will guide the user through the required data needed for the install.
 * @param err - Errors from the previous (Terms and Conditions) waterfall function.
 * @param callback
 */
function wizard(err, callback) {
    prompt.message = ``;
    winston.info('Starting install wizard');
    let admin_username;
    let install_schema = {
        properties: {
            HDB_ROOT: {
                description: colors.magenta(`[HDB_ROOT] Please enter the destination for HarperDB`),
                message: 'HDB_ROOT cannot contain /',
                default: (env.getHdbBasePath() ? env.getHdbBasePath() : process.env['HOME'] + '/hdb'),
                ask: function () {
                    // only ask for HDB_ROOT if it is not defined.
                    if (env.getHdbBasePath()) {
                        console.log(`Using previous install path: ${env.getHdbBasePath()}`);
                        return false;
                    }
                    return true;
                },
                required: false
            },
            NODE_NAME: {
                description: colors.magenta(`[NODE_NAME] Please enter a unique name for this node`),
                default: (hri.random()),
                required: false
            },
            SERVER_PORT: {
                pattern: /^([0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/,
                description: colors.magenta(`[SERVER_PORT] Please enter a server listening port for HarperDB`),
                message: 'Invalid port.',
                default: 9925,
                required: false
            },
            CLUSTERING_PORT: {
                pattern: /^([0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/,
                description: colors.magenta(`[CLUSTERING_PORT] Please enter a listening port for Clustering`),
                message: 'Invalid port.',
                default: 1111,
                required: false
            },
            HDB_ADMIN_USERNAME: {
                description: colors.magenta('[HDB_ADMIN_USERNAME] Please enter a username for the HDB_ADMIN'),
                default: 'HDB_ADMIN',
                required: true
            },
            HDB_ADMIN_PASSWORD: {
                description: colors.magenta('[HDB_ADMIN_PASSWORD] Please enter a password for the HDB_ADMIN'),
                hidden: true,
                required: true
            },
            CLUSTERING_USERNAME: {
                description: colors.magenta('[CLUSTERING_USERNAME] Please enter a username for the CLUSTERING USER'),
                default: 'CLUSTER_USER',
                message: 'Specified username is invalid or already in use.',
                required: true,
                // check clustering user name not the same as admin user name
                conform: function (username) {
                    if (username === admin_username) {
                        return false;
                    }
                    return true;
                }
            },
            CLUSTERING_PASSWORD: {
                description: colors.magenta('[CLUSTERING_PASSWORD] Please enter a password for the CLUSTERING USER'),
                hidden: true,
                required: true
            }
        }
    };

    const ARGS = minimist(process.argv.slice(2));
    if(ARGS.enable_clustering === undefined){
        delete install_schema.properties.NODE_NAME;
        delete install_schema.properties.CLUSTERING_PASSWORD;
        delete install_schema.properties.CLUSTERING_PORT;
        delete install_schema.properties.CLUSTERING_USERNAME;
    }

    console.log(colors.magenta('' + fs.readFileSync(path.join(__dirname, './ascii_logo.txt'))));
    console.log(colors.magenta('                    Installer'));

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
            if (!fs.existsSync(wizard_result.HDB_ROOT) ||
                !fs.existsSync(wizard_result.HDB_ROOT + '/config/settings.js') ||
                !fs.existsSync(wizard_result.HDB_ROOT + '/schema/system')) {
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

function createSuperUser(callback){
    winston.info('Creating Super user.');
    let role = {
        role: 'super_user',
        permission: {
            super_user:true
        }
    };

    let user = {
        username: wizard_result.HDB_ADMIN_USERNAME,
        password: wizard_result.HDB_ADMIN_PASSWORD,
        active: true
    };

    createAdminUser(role, user, (err)=>{
        if(err){
            return callback(err);
        }

        callback();
    });
}

function createClusterUser(callback){
    winston.info('Creating Cluster user.');
    let role = {
        role: 'cluster_user',
        permission: {
            cluster_user:true
        }
    };

    let user = undefined;
    if(wizard_result.CLUSTERING_USERNAME !== undefined && wizard_result.CLUSTERING_PASSWORD !== undefined){
        user = {
            username: wizard_result.CLUSTERING_USERNAME,
            password: wizard_result.CLUSTERING_PASSWORD,
            active: true
        };
    }

    createAdminUser(role, user, (err)=>{
        if(err){
            return callback(err);
        }

        callback();
    });
}

function createAdminUser(role, admin_user, callback) {
    winston.info('Creating admin user.');
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
                winston.error('role failed to create ' + err);
                console.log('There was a problem creating the default role.  Please check the install log for details.');
                return callback(err);
            }

            if(admin_user === undefined){
                return callback(null);
            }

            admin_user.role = res.role;

            cb_user_add_user(admin_user, (add_user_err) => {
                if (add_user_err) {
                    winston.error('user creation error' + add_user_err);
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
    winston.info('Creating settings file.');
    if (mount_status !== 'complete') {
        winston.error('mount failed.');
        return callback('mount failed');
    }

    let settings_path = `${wizard_result.HDB_ROOT}/config/settings.js`;
    createBootPropertiesFile(settings_path, (err) => {
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
        } catch (cpus_err) {
            //No-op, should only get here in the case of android.  Defaulted to 4.
        }
        const path_module = require('path');

        const ARGS = minimist(process.argv.slice(2));
        let clustering_enabled = ARGS.enable_clustering !== undefined;
        let clustering_port = wizard_result.CLUSTERING_PORT !== undefined ? wizard_result.CLUSTERING_PORT : '';
        let node_name = wizard_result.NODE_NAME !== undefined ? wizard_result.NODE_NAME : '';
        let clustering_username = wizard_result.CLUSTERING_USERNAME !== undefined ? wizard_result.CLUSTERING_USERNAME : '';

        let HDB_SETTINGS_NAMES = hdb_terms.HDB_SETTINGS_NAMES;

        let hdb_props_value = `   ;Settings for the HarperDB process.\n` +
            `\n` +
            `   ;The directory harperdb has been installed in.\n` +
            `${HDB_SETTINGS_NAMES.PROJECT_DIR_KEY} = ${path_module.resolve(__dirname, '../../')}\n` +
            `   ;The directory selected during install where the database files reside.\n` +
            `${HDB_SETTINGS_NAMES.HDB_ROOT_KEY} = ${wizard_result.HDB_ROOT}\n` +
            `   ;The port the HarperDB REST interface will listen on.\n` +
            `${HDB_SETTINGS_NAMES.SERVER_PORT_KEY} = ${wizard_result.SERVER_PORT}\n` +
            `   ;The path to the SSL certificate used when running with HTTPS enabled.\n` +
            `${HDB_SETTINGS_NAMES.CERT_KEY} = ${wizard_result.HDB_ROOT}/keys/certificate.pem\n` +
            `   ;The path to the SSL private key used when running with HTTPS enabled.\n` +
            `${HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY} = ${wizard_result.HDB_ROOT}/keys/privateKey.pem\n` +
            `   ;Set to true to enable HTTPS on the HarperDB REST endpoint.  Requires a valid certificate and key.\n` +
            `${HDB_SETTINGS_NAMES.HTTP_SECURE_ENABLED_KEY} = false\n` +
            `   ;Set to true to enable Cross Origin Resource Sharing, which allows requests across a domain.\n` +
            `${HDB_SETTINGS_NAMES.CORS_ENABLED_KEY} = true\n` +
            `   ;Allows for setting allowable domains with CORS. Comma separated list.\n` +
            `${HDB_SETTINGS_NAMES.CORS_WHITELIST_KEY} =\n` +
            `   ;Length of time in milliseconds after which a request will timeout.  Defaults to 120,000 ms (2 minutes).\n` +
            `${HDB_SETTINGS_NAMES.SERVER_TIMEOUT_KEY} = 120000\n` +
            `   ;The number of milliseconds of inactivity a server needs to wait for additional incoming data, after it has finished writing the last response.  Defaults to 5,000 ms (5 seconds).\n` +
            `${HDB_SETTINGS_NAMES.SERVER_KEEP_ALIVE_TIMEOUT_KEY} = 5000\n` +
            `   ;Limit the amount of time the parser will wait to receive the complete HTTP headers..  Defaults to 60,000 ms (1 minute).\n` +
            `${HDB_SETTINGS_NAMES.SERVER_HEADERS_TIMEOUT_KEY} = 60000\n` +
            `   ;Set to control amount of logging generated.  Accepted levels are trace, debug, warn, error, fatal.\n` +
            `${HDB_SETTINGS_NAMES.LOG_LEVEL_KEY} = warn\n` +
            `   ;Setting LOGGER to 1 uses the WINSTON logger.\n` +
            `   ; 2 Uses the more performant PINO logger.\n` +
            `${HDB_SETTINGS_NAMES.LOGGER_KEY} = 1\n` +
            `   ;The path where log files will be written. If there is no file name included in the path, the log file will be created by default as 'hdb_log.log' \n` +
            `${HDB_SETTINGS_NAMES.LOG_PATH_KEY} = ${wizard_result.HDB_ROOT}/log/hdb_log.log\n` +
            `   ;Set to true to enable daily log file rotations - each log file name will be prepended with YYYY-MM-DD (for WINSTON logger only).\n` +
            `${HDB_SETTINGS_NAMES.LOG_DAILY_ROTATE_KEY} = false\n` +
            `   ;Set the number of daily log files to maintain when LOG_DAILY_ROTATE is enabled. If no integer value is set, no limit will be set for\n` +
            `   ;daily log files which may consume a large amount of storage depending on your log settings.\n` +
            `${HDB_SETTINGS_NAMES.LOG_MAX_DAILY_FILES_KEY} =\n` +
            `   ;The environment used by NodeJS.  Setting to production will be the most performant, settings to development will generate more logging.\n` +
            `${HDB_SETTINGS_NAMES.PROPS_ENV_KEY} = production\n` +
            `   ;This allows self signed certificates to be used in clustering.  This is a security risk\n` +
            `   ;as clustering will not validate the cert, so should only be used internally.\n` +
            `   ;The HDB install creates a self signed certificate, if you use that cert this must be set to true.\n` +
            `${HDB_SETTINGS_NAMES.ALLOW_SELF_SIGNED_SSL_CERTS} = false\n` +
            `   ;Set the max number of processes HarperDB will start.  This can also be limited by number of cores and licenses.\n` +
            `${HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES} = ${num_cores}\n` +
            `   ;Set to true to enable clustering.  Requires a valid enterprise license.\n` +
            `${HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY} = ${clustering_enabled}\n` +
            `   ;The port that will be used for HarperDB clustering.\n` +
            `${HDB_SETTINGS_NAMES.CLUSTERING_PORT_KEY} = ${clustering_port}\n` +
            `   ;The name of this node in your HarperDB cluster topology.  This must be a value unique from the rest of your cluster node names.\n` +
            `${HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY}=${node_name}\n` +
            `   ;The user used to connect to other instances of HarperDB, this user must have a role of cluster_user. \n` +
            `${HDB_SETTINGS_NAMES.CLUSTERING_USER_KEY}=${clustering_username}\n` +
            `   ;Defines if this instance does not record transactions. Note, if Clustering is enabled and Transaction Log is disabled your nodes will not catch up.  \n` +
            `${HDB_SETTINGS_NAMES.DISABLE_TRANSACTION_LOG_KEY} = false\n` +
            `   ;Defines the length of time an operation token will be valid until it expires. Example values: https://github.com/vercel/ms  \n` +
            `${HDB_SETTINGS_NAMES.OPERATION_TOKEN_TIMEOUT_KEY} = 1d\n` +
            `   ;Defines the length of time a refresh token will be valid until it expires. Example values: https://github.com/vercel/ms  \n` +
            `${HDB_SETTINGS_NAMES.REFRESH_TOKEN_TIMEOUT_KEY} = 30d\n`
        ;

        winston.info('info', `hdb_props_value ${JSON.stringify(hdb_props_value)}`);
        winston.info('info', `settings path: ${env.get('settings_path')}`);
        try {
            fs.writeFile(env.get('settings_path'), hdb_props_value, function (fs_write_file_err) {
                if (fs_write_file_err) {
                    console.error('There was a problem writing the settings file.  Please check the install log for details.');
                    winston.error(fs_write_file_err);
                    return callback(fs_write_file_err);
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
        fs.writeFile(env.get('PRIVATE_KEY'), forge.pki.privateKeyToPem(keys.privateKey), function (fs_write_file_err) {
            if (fs_write_file_err) {
                winston.error(fs_write_file_err);
                console.error('There was a problem creating the private key file.  Please check the install log for details.');
                return callback(fs_write_file_err);
            }
            return callback();
        });
    });
}


function setupService(callback) {
    fs.readFile(`./utility/install/harperdb.service`, 'utf8', function (err, data) {
        let fileData = data.replace('{{project_dir}}', `${env.get('PROJECT_DIR')}`).replace('{{hdb_directory}}',
            env.get('HDB_ROOT'));
        fs.writeFile('/etc/systemd/system/harperdb.service', fileData, function (fs_write_file_err) {

            if (fs_write_file_err) {
                winston.info('error', `Service Setup Error ${fs_write_file_err}`);
                console.error('There was a problem setting up the service.  Please check the install log for details.');
                return callback(fs_write_file_err);
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
    let home_dir_keys_dir_path = path.join(home_dir_path, hdb_terms.LICENSE_KEY_DIR_NAME);
    try {
        fs.mkdirpSync(home_dir_path, {mode: hdb_terms.HDB_FILE_PERMISSIONS});
        fs.mkdirpSync(home_dir_keys_dir_path, {mode: hdb_terms.HDB_FILE_PERMISSIONS});
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
        env.setPropsFilePath(props_file_path);
        return callback(null, 'success');
    });
}
