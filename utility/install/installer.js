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


function run_install(callback) {
    prompt.start();
    //winston.add(winston.transports.File, { filename: 'installer.log' });
    winston.configure({
        transports: [
            new (winston.transports.File)({filename: '../install_hdb.log'})
        ]
    });

    checkInstall(function(err, keepGoing){
       if(keepGoing){
           async.waterfall([
               wizard,
               mount,
               createSettingsFile,
            //   installInotify,
               checkRegister

           ], function (err, result) {
               callback(err, result);

           });
        }

    });



}


function installInotify(callback) {
    var getos = require('getos')

    getos(function (e, os) {
        if (e) return console.log(e)

        let command_str = 'yum install inotify-tools';
        if (os.dist.toLowerCase().indexOf('ubuntu') > -1) {
            command_str = 'apt-get install inotify-tools;';
        }


        var sudo = require('sudo-prompt');
        var options = {
            name: 'HarperDB',

        };
        sudo.exec(command_str, options, function (error, stdout, stderr) {
            if (error || stderr) {
                //winston.log('error', 'inotifyinstall error ' + error + ' ' + stderr)
                callback(error + ' ' + stderr);
                return;
            }

            callback();

        });


    })

}

function checkInstall(callback) {
    try{
        if (!hdb_boot_properties) {
            hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
            hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
            if (hdb_properties.get('HDB_ROOT')) {

                var schema = {
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

    if (wizard_result.HDB_REGISTER) {
        register = require('../registrationHandler'),
            register(prompt, function (err, result) {
                if (err) {
                    callback(err);
                    returnl
                }
                callback(null, "Successful installation!!");
                return;
            });


    } else {
        callback(null, 'Successful installation!');
        winston.log('info', 'HarperDB successfully installed!');
    }
}


function wizard(callback) {
    prompt.message = 'Install HarperDB ' + __dirname;


    var install_schema = {
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
                type: 'boolean',
                default: true,
                required: true
            },


        }
    };


    console.log(colors.magenta('' + fs.readFileSync(path.join(__dirname,'./ascii_logo.txt'))));
    console.log(colors.magenta('                    Installer'));



    prompt.get(install_schema, function (err, result) {
        wizard_result = result;
        //prompt.stop();
        if (err) {
            callback(err);
            return;
        }

        callback(null, wizard_result.HDB_ROOT);


    });
}

function createSettingsFile(mount_status, callback) {

    if (mount_status != 'complete') {
        callback('mount failed');
        return;
    }


    createBootPropertiesFile(`${wizard_result.HDB_ROOT}/config/settings.js`, (err) => {
        if (err) {
            callback(err);
            return;
        }

        const path = require('path');
        var hdb_props_value = `PROJECT_DIR = ${path.resolve(process.cwd(),'../')}
        HDB_ROOT= ${wizard_result.HDB_ROOT}
        TCP_PORT = ${wizard_result.TCP_PORT}
        HTTP_PORT = ${wizard_result.HTTP_PORT}
        HDB_ADMIN_USERNAME = ${wizard_result.HDB_ADMIN_USERNAME}
        HDB_ADMIN_PASSWORD = ${password.hash(wizard_result.HDB_ADMIN_PASSWORD)}`;

        fs.writeFile(hdb_boot_properties.get('settings_path'), hdb_props_value, function (err, data) {


            hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));

        });
        callback(null);
        return;


    });
}


function setupService(callback) {
    fs.readFile(`./utility/install/harperdb.service`, 'utf8', function (err, data) {
        var fileData = data.replace('{{project_dir}}', `${hdb_properties.get('PROJECT_DIR')}`).replace('{{hdb_directory}}',
            hdb_properties.get('HDB_ROOT'));
        fs.writeFile('/etc/systemd/system/harperdb.service', fileData, function (err, result) {

            if (err) {
                winston.log('error', `Service Setup Error ${err}`);
                callback(err);
                return;
            }

            var terminal = spawn('bash');
            terminal.stderr.on('data', function (data) {
                //console.log('error',`Express server failed to run: ${data}`);
                //console.log('' + data);
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


    if (!settings_path) {
        callback('missing setings');
        return;
    }

    fs.writeFile(`${process.cwd()}/../hdb_boot_properties.file`, `settings_path = ${settings_path}`, function (err, data) {
        if (err) {
            winston.log('error', `Bootloader ${err}`);
            console.log(err);

            //callback(err);
            return;
        }

        hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);


        callback(null, data);
        return;


    });

}
