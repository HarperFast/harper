const prompt = require('prompt'),
    spawn = require('child_process').spawn,
    path = require('path'),
    password = require('./../password'),
    mount = require('./../mount_hdb'),
    fs = require('fs'),
    colors = require("colors/safe"),
    winston = require('winston'),
    isRoot = require('is-root'),
    async = require('async'),
    optimist = require('optimist'),
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
                        callback(null, true);

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
        console.log('info', 'HarperDB successfully installed!');
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
            TCP_PORT: {
                pattern: /^([0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/,
                description: colors.magenta(`[TCP_PORT] Please enter a TCP listening port for HarperDB `),
                message: 'Invalid port.',
                default: 9925,
                required: false
            },
            HTTP_PORT: {
                pattern: /^([0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/,
                description: colors.magenta(`[HTTP_PORT] Please enter an HTTP listening port for HarperDB`),
                message: 'Invalid port.',
                default: 5299,
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
        winston.info('info', 'wizard result : ' + JSON.stringify(wizard_result));
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
           winston.info('info', 'role failed to create ' + err);
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
               winston.info('info', 'user creation error' + err);
               callback(err);
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
        TCP_PORT = ${wizard_result.TCP_PORT}
        HTTP_PORT = ${wizard_result.HTTP_PORT}`;


        winston.info('info', `hdb_props_value ${JSON.stringify(hdb_props_value)}`);
        winston.info('info', `settings path: ${hdb_boot_properties.get('settings_path')}`);
        try {
            fs.writeFile(hdb_boot_properties.get('settings_path'), hdb_props_value, function (err, data) {
                if (err) {
                    winston.info('info', err);
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
