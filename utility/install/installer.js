/**
 * INSTALLER.JS
 *
 * This module is used to install HarperDB.  It is meant to be a self contained module which is why it configures
 * it's own winston instance.
 */

const prompt = require('prompt'),
    spawn = require('child_process').spawn,
    path = require('path'),
    mount = require('./../mount_hdb'),
    fs = require('fs.extra'),
    colors = require("colors/safe"),
    winston = require('winston'),
    async = require('async'),
    optimist = require('optimist'),
    LOG_LOCATION = ('../install_log.log'),
    forge = require('node-forge');

PropertiesReader = require('properties-reader');
let hdb_boot_properties = null,
    hdb_properties = null;

module.exports = {
    "install": run_install
};

let wizard_result;

/**
 * Stars the install process by first checking for an existing installation, then firing the steps to complete the install.
 * Information required to complete the install is root path, desired harper port, TCP port, username, and password.
 * @param callback
 */
function run_install(callback) {
    winston.configure({
        transports: [
            new (winston.transports.File)({
                filename: LOG_LOCATION, level: 'verbose', handleExceptions: true,
                prettyPrint: true
            })
        ], exitOnError: false
    });

    prompt.override = optimist.argv;
    prompt.start();
    winston.info('info', 'starting install');
    checkInstall(function (err, keepGoing) {
        if (keepGoing) {
            async.waterfall([
                wizard,
                mount,
                createSettingsFile,
                createAdminUser,
                generateKeys,
                () => {
                    console.log("HarperDB Installation was successful");
                    winston.info("Installation Successful");
                }
            ], function (err, result) {
                if (err) {
                    return callback(err, result);
                }
            });
        }
        return callback(null, result);
    });
}

/**
 * Checks for the presence of an existing install by finding the hdb_boot props file.  If the file is found, the user
 * is prompted for a decision to reinstall over the existing installation.
 * @param callback
 */
function checkInstall(callback) {
    try {
        if( hdb_boot_properties ) { return callback(null, false); }

        hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
        hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
        if( !hdb_boot_properties.get('HDB_ROOT') ) { return callback(null, true); }

        let schema = {
            properties: {
                REINSTALL: {
                    message: colors.red('It appears HarperDB is already installed.  Enter \'y/yes\'to reinstall. Data loss may occur! (yes/no)'),
                    validator: /y[es]*|n[o]?/,
                    warning: 'Must respond yes or no',
                    default: 'no'
                }
            }
        };

        prompt.get(schema, function (err, result) {
            if( err ) { callback(err); }

            if(result.REINSTALL === 'yes' || result.REINSTALL === 'y') {
                fs.rmrf(hdb_properties.get('HDB_ROOT'), function (err) {
                    if (err) {
                        winston.error(err);
                        console.log('There was a problem removing the existing installation.  Please check the install log for details.');
                        return callback(err);
                    }
                    fs.unlink(`${process.cwd()}/../hdb_boot_properties.file`, function (err) {
                        if (err) {
                            winston.error(err);
                            console.log('There was a problem removing the existing installation.  Please check the install log for details.');
                            return callback(err);
                        }
                        return callback(null, true);
                    });
                });
            }
            callback(null, false);
        });
    }
    catch (e) {
        return callback(null, true);
    }
}

function checkRegister(callback) {
    if (wizard_result.HDB_REGISTER === 'true') {
        register = require('../registrationHandler'),
            register.register(prompt, function (err, result) {
                if (err) {
                    return callback(err);
                }
                return callback(null, "Successful installation!");
            });
    }
}

/**
 * The install wizard will guide the user through the required data needed for the install.
 * @param callback
 */
function wizard(callback) {
    prompt.message = 'Install HarperDB ' + __dirname;

    let install_schema = {
        properties: {
            HDB_ROOT: {
                description: colors.magenta(`[HDB_ROOT] Please enter the destination for HarperDB`),
                message: 'HDB_ROOT cannot contain /',
                default: process.env['HOME'] + '/hdb',
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
                required: true
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
            if( home !== undefined && home !== null) {
                let replacement = wizard_result.HDB_ROOT.replace('~', process.env['HOME']);
                if (replacement && replacement.length > 0) {
                    wizard_result.HDB_ROOT = replacement;
                }
            }
            else {
                callback('~ was specified in the path, but the HOME environment variable is not defined.');
            }
        }
        winston.info('wizard result : ' + JSON.stringify(wizard_result));
        if (err) {
            return callback(err);
        }
        callback(null, wizard_result.HDB_ROOT);
    });
}

function createAdminUser(callback) {
    const user_ops = require('../../security/user');
    const role_ops = require('../../security/role');

    let role = {};
    role.role = 'super_user';
    role.permission = {};
    role.permission.super_user = true;

    role_ops.addRole(role, function (err, result) {
        if (err) {
            winston.error('role failed to create ' + err);
            console.log('There was a problem creating the default role.  Please check the install log for details.');
            return callback(err);
        }

        let admin_user = {};
        admin_user.username = wizard_result.HDB_ADMIN_USERNAME;
        admin_user.password = wizard_result.HDB_ADMIN_PASSWORD;
        admin_user.role = result.id;
        admin_user.active = true;

        user_ops.addUser(admin_user, function (err, result) {
            if (err) {
                winston.error('user creation error' + err);
                console.error('There was a problem creating the admin user.  Please check the install log for details.');
                return callback(err);
            }
            return callback(null);
        });
    });
}

function createSettingsFile(mount_status, callback) {
    console.log('Starting HarperDB Install...');
    if (mount_status !== 'complete') {
        return callback('mount failed');
    }

    createBootPropertiesFile(`${wizard_result.HDB_ROOT}/config/settings.js`, (err) => {
        winston.info('info', `creating settings file....`);

        if (err) {
            winston.info('info', 'boot properties error' + err);
            console.error('There was a problem creating the boot file.  Please check the install log for details.');
            return callback(err);
        }

        const path = require('path');
        let hdb_props_value = `PROJECT_DIR = ${path.resolve(process.cwd(),'../')}\n` +
            `HDB_ROOT = ${wizard_result.HDB_ROOT}\n` +
            `HTTP_PORT = ${wizard_result.HTTP_PORT}\n` +
            `HTTPS_PORT = ${wizard_result.HTTPS_PORT}\n` +
            `CERTIFICATE = ${wizard_result.HDB_ROOT}/keys/certificate.pem\n` +
            `PRIVATE_KEY = ${wizard_result.HDB_ROOT}/keys/privateKey.pem\n` +
            `HTTPS_ON = FALSE\n` +
            `HTTP_ON = TRUE \n` +
            `CORS_ON = TRUE\n` +
            `CORS_WHITELIST =\n` +
            `SERVER_TIMEOUT_MS = 120000\n`;

        winston.info('info', `hdb_props_value ${JSON.stringify(hdb_props_value)}`);
        winston.info('info', `settings path: ${hdb_boot_properties.get('settings_path')}`);
        try {
            fs.writeFile(hdb_boot_properties.get('settings_path'), hdb_props_value, function (err, data) {
                if (err) {
                    console.error('There was a problem writing the settings file.  Please check the install log for details.');
                    winston.error(err);
                    return callback(err);
                }
                hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
                return callback(null);
            });
        } catch (e) {
            winston.info(e);
            winston.info('info', e);
        }
    });
}

function generateKeys(callback) {
    let pki = forge.pki;
    let keys = pki.rsa.generateKeyPair(2048);
    let cert = pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    let attrs = [{
        name: 'commonName',
        value: 'harperdb.io'
    }, {
        name: 'countryName',
        value: 'US'
    }, {
        shortName: 'ST',
        value: 'Colorado'
    }, {
        name: 'localityName',
        value: 'Denver'
    }, {
        name: 'organizationName',
        value: 'HarperDB, Inc'
    }, {
        shortName: 'OU',
        value: 'HDB'
    }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{
        name: 'basicConstraints',
        cA: true,
        id: 'hdb_1.0'
    }, {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        nonRepudiation: true,
        keyEncipherment: true,
        dataEncipherment: true
    }, {
        name: 'extKeyUsage',
        serverAuth: true,
        clientAuth: true,
        codeSigning: true,
        emailProtection: true,
        timeStamping: true
    }, {
        name: 'nsCertType',
        client: true,
        server: true,
        email: true,
        objsign: true,
        sslCA: true,
        emailCA: true,
        objCA: true
    }, {
        name: 'subjectAltName',
        altNames: [{
            type: 6, // URI
            value: 'http://example.org/webid#me'
        }, {
            type: 7, // IP
            ip: '127.0.0.1'
        }]
    }, {
        name: 'subjectKeyIdentifier'
    }]);

    cert.sign(keys.privateKey);

    // convert a Forge certificate to PEM
    fs.writeFile(hdb_properties.get('CERTIFICATE'), pki.certificateToPem(cert), function (err, data) {
        if (err) {
            winston.error(err);
            console.error('There was a problem creating the PEM file.  Please check the install log for details.');
            return callback(err);
        }
        fs.writeFile(hdb_properties.get('PRIVATE_KEY'), forge.pki.privateKeyToPem(keys.privateKey), function (err, data) {
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
        let fileData = data.replace('{{project_dir}}', `${hdb_properties.get('PROJECT_DIR')}`).replace('{{hdb_directory}}',
            hdb_properties.get('HDB_ROOT'));
        fs.writeFile('/etc/systemd/system/harperdb.service', fileData, function (err, result) {

            if (err) {
                winston.info('error', `Service Setup Error ${err}`);
                console.error('There was a problem setting up the service.  Please check the install log for details.');
                return callback(err);
            }

            let terminal = spawn('bash');
            terminal.stderr.on('data', function (data) {
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
        winston.info('info', 'missing settings path');
        return callback('missing setings');
    }

    let boot_props_value = `settings_path = ${settings_path}
    install_user = ${require("os").userInfo().username}`;

    fs.writeFile(`${process.cwd()}/../hdb_boot_properties.file`, boot_props_value, function (err) {

        if (err) {
            winston.error('info', `Bootloader error ${err}`);
            console.error('There was a problem creating the boot file.  Please check the install log for details.');
            return callback(err);
        }
        winston.info('info', `props path ${process.cwd()}/../hdb_boot_properties.file`);
        hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
        winston.info('hdb_boot_properties' + hdb_boot_properties);
        return callback(null, 'success');
    });
}
