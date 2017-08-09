const prompt = require('prompt'),
    spawn = require('child_process').spawn,
    path = require('path'),
    password = require('./../password'),
    mount = require('./../mount_hdb'),
    fs = require('fs.extra'),
    colors = require("colors/safe"),
    winston = require('winston'),
    isRoot = require('is-root'),
    async = require('async'),
    optimist = require('optimist'),
    forge = require('node-forge'),
    PropertiesReader = require('properties-reader');
var hdb_boot_properties = null,
    hdb_properties = null;
//var settings = null;


//

// Start the prompt
//

//
// Get two properties from the user: username and email
//
//TODO figure out SSL for express.


module.exports = {
    "install": run_install
}


//'HDB_ROOT', 'HDB_PORT', 'TCP_PORT','USERNAME', 'PASSWORD'

var wizard_result;
//wizard_result = {"HDB_ROOT":"/home/stephen/hdb","TCP_PORT":"9925","HTTP_PORT":"5299","HDB_ADMIN_USERNAME":"admin","HDB_ADMIN_PASSWORD":"false","HDB_REGISTER":false};





function run_install(callback) {
    winston.configure({
        transports: [

            new (winston.transports.File)({ filename: '../install_log.log',  level: 'verbose', handleExceptions: true,
                prettyPrint:true })
        ],exitOnError:false
    });

    prompt.override = optimist.argv;
    prompt.start();
    //winston.add(winston.transports.File, { filename: 'installer.log' });

    winston.info('info', 'starting install');
    checkInstall(function(err, keepGoing){
       if(keepGoing){
           async.waterfall([
               wizard,
               mount,
               createSettingsFile,
               createAdminUser,
               generateKeys,
               checkRegister

           ], function (err, result) {
               callback(err, result);

           });
        }

    });



}



function checkInstall(callback) {
    try{
        if (!hdb_boot_properties) {
            hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
            hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
            if (hdb_properties.get('HDB_ROOT')) {

                let schema = {
                    properties: {
                        REINSTALL: {
                            description: colors.red('It appears HarperDB is already installed.  Would you like to continue? Data loss may occur!'),
                            required: true,
                            default: false,
                            type: 'boolean'
                        }
                    }
                };

                prompt.get(schema, function (err, result) {
                    if(err){
                        callback(err);
                    }
                    if(result.REINSTALL){
                        fs.rmrf(hdb_properties.get('HDB_ROOT'), function(err){
                            if(err){
                                winston.error(err);
                               return callback(err);
                            }
                            fs.unlink(`${process.cwd()}/../hdb_boot_properties.file`, function(err){
                                if(err){
                                    winston.error(err);
                                    return callback(err);
                                }
                               return callback(null, true);

                            });



                        });

                    }

                    callback(null, false);
                    return;
                });

            } else {
                callback(null, true);
                return;
            }
        } else {
            callback(null, false);
            return;
        }
    }
    catch(e){
        callback(null, true);
        return;
    }



}

function checkRegister(callback) {

    if (wizard_result.HDB_REGISTER == 'true') {
        register = require('../registrationHandler'),
            register.register(prompt, function (err, result) {
                if (err) {
                    callback(err);
                    return;
                }

                callback(null, "Successful installation!!");
                return;
            });


    } else {
        callback(null, 'Successful installation!');
        console.log('HarperDB successfully installed!');
    }
}


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
            },
            HDB_REGISTER: {
                description: colors.magenta('[REGISTER] Would you like to register now?'),       
                default: 'true',
                required: true
            },


        }
    };


    console.log(colors.magenta('' + fs.readFileSync(path.join(__dirname,'./ascii_logo.txt'))));
    console.log(colors.magenta('                    Installer'));



    prompt.get(install_schema, function (err, result) {
        wizard_result = result;
        winston.info('wizard result : ' + JSON.stringify(wizard_result));
        //prompt.stop();
        if (err) {
            callback(err);
            return;
        }

        callback(null, wizard_result.HDB_ROOT);


    });
}

function createAdminUser(callback){
    var user_ops = require('../../security/user');
    var role_ops = require('../../security/role');

    let role = {};
    role.role = 'super_user';
    role.permission = {};
    role.permission.super_user = true;


    role_ops.addRole(role, function(err, result){
       if(err){
           winston.error('role failed to create ' + err);
           callback(err);
           return;
       }

        let admin_user = {};
        admin_user.username = wizard_result.HDB_ADMIN_USERNAME;
        admin_user.password =wizard_result.HDB_ADMIN_PASSWORD;
        admin_user.role = result.id
        admin_user.active = true;


        user_ops.addUser(admin_user, function(err, result){
           if(err){
               winston.error('user creation error' + err);
              return callback(err);
           }
           callback(null);
           return;
        });


    });




}


function createSettingsFile(mount_status, callback) {

    if (mount_status != 'complete') {
        callback('mount failed');
        return;
    }


    createBootPropertiesFile(`${wizard_result.HDB_ROOT}/config/settings.js`, (err) => {
        winston.info('info', `creating settings file....`);


        if (err) {
            winston.info('info', 'boot properties error' + err);
            callback(err);
            return;
        }

        const path = require('path');
        let hdb_props_value = `PROJECT_DIR = ${path.resolve(process.cwd(),'../')}
        HDB_ROOT= ${wizard_result.HDB_ROOT}
        HTTP_PORT = ${wizard_result.HTTP_PORT}
        HTTPS_PORT = ${wizard_result.HTTPS_PORT}
        CERTIFICATE = ${wizard_result.HDB_ROOT}/keys/certificate.pem
        PRIVATE_KEY = ${wizard_result.HDB_ROOT}/keys/privateKey.pem
        HTTPS_ON = FALSE
        HTTP_ON = TRUE`;


        winston.info('info', `hdb_props_value ${JSON.stringify(hdb_props_value)}`);
        winston.info('info', `settings path: ${hdb_boot_properties.get('settings_path')}`);
        try {
            fs.writeFile(hdb_boot_properties.get('settings_path'), hdb_props_value, function (err, data) {
                if (err) {
                    winston.error(err);
                }
                hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
                callback(null);
                return;
            });
        }catch(e)
        {
            winston.info(e);
            winston.info('info', e);
        }



    });
}



function generateKeys(callback){
    let pki = forge.pki;
    let keys = pki.rsa.generateKeyPair(2048);
    let cert = pki.createCertificate();
    cert.publicKey = keys.publicKey;
// alternatively set public key from a csr
//cert.publicKey = csr.publicKey;
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
            return callback(err);
        }
        fs.writeFile(hdb_properties.get('PRIVATE_KEY'), forge.pki.privateKeyToPem(keys.privateKey), function (err, data) {
            if (err) {
                winston.error(err);
                return callback(err);
            }
            return callback();

        });


    });


}


function setupService(callback) {
    fs.readFile(`./utility/install/harperdb.service`, 'utf8', function (err, data) {
        var fileData = data.replace('{{project_dir}}', `${hdb_properties.get('PROJECT_DIR')}`).replace('{{hdb_directory}}',
            hdb_properties.get('HDB_ROOT'));
        fs.writeFile('/etc/systemd/system/harperdb.service', fileData, function (err, result) {

            if (err) {
                winston.info('error', `Service Setup Error ${err}`);
                callback(err);
                return;
            }

            var terminal = spawn('bash');
            terminal.stderr.on('data', function (data) {
                //winston.info('error',`Express server failed to run: ${data}`);
                //winston.info('' + data);
                //Here is where the error output goes
            });


            terminal.stdin.write(`sudo systemctl daemon-reload &`);
            terminal.stdin.end();

            callback(null, 'success');
            return;

        });
    });
}

function createBootPropertiesFile(settings_path, callback) {

    winston.info('info', 'creating boot file');
    if (!settings_path) {
        winston.info('info', 'missing settings path');
        callback('missing setings');
        return;
    }

    fs.writeFile(`${process.cwd()}/../hdb_boot_properties.file`, `settings_path = ${settings_path}`, function (err) {

        if (err) {
            winston.info('info', `Bootloader error ${err}`);
            winston.info(err);
            callback(err);
            return;
        }
        winston.info('info', `props path ${process.cwd()}/../hdb_boot_properties.file`)
        hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
        winston.info('hdb_boot_properties' + hdb_boot_properties);


        callback(null, 'success');
        return;


    });

}
