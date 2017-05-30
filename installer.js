const prompt = require('prompt'),
    spawn = require('child_process').spawn,
    password = require('./utility/password'),
    mount = require('./utility/mount_hdb'),
    fs = require('fs'),
    colors = require("colors/safe"),
    hdb_license = require('./utility/hdb_license'),
    isRoot = require('is-root'),
    async = require('async'),
    boot_loader = require('./utility/hdb_boot_loader'),
    register = require('./register');

var settings = null;


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
var newInstall = true;

function run_install(callback) {

    if (!isRoot()) {
        callback("Must install as root!");
        return;
    }
    async.waterfall([
        wizard,
        createSettingsFile,
        mount,
        setupService,
        checkRegister

    ], function (err, result) {
        callback(err, result);

    });


}

function checkInstall(callback){
    boot_loader.getBootLoader(function (err, data) {

        if(err){
            callback(err);
            return;
        }
        if(data){
            settings = require(data.settings);
            callback(null, data);
            return;
        }


    })
}

function checkRegister(callback) {
    console.log(`wizaard register:` + wizard_result.HDB_REGISTER);
    if (wizard_result.HDB_REGISTER) {
        register.register(function (err, result) {
            if (err) {
                callback(err);
                returnl
            }
            callback(null, "Successful installation!!");
            return;
        });


    } else {
        callback(null, 'Successful installation!');
        console.log('Successful installation!');
    }
}



function wizard(callback) {
    prompt.message = 'Install HarperDB ' + __dirname;


    var install_schema = {
        properties: {
            REINSTALL: {
                description: "It appears that HarperDB is already installed, do you wish to reinstall... data loss may occur.",
                type: 'boolean',
                required: true,
                default: false,
                ask: function () {
                    return !newInstall;
                }

            }

            ,
            HDB_ROOT: {
                description: colors.magenta(`[HDB_ROOT] Please enter the destination for HarperDB`),
                message: 'HDB_ROOT cannot contain /',
                default: process.env['HOME'] + '/hdb',
                required: false,
                ask: function () {
                    return newInstall || !newInstall && prompt.history('REINSTALL').value;
                }
            },
            TCP_PORT: {
                pattern: /^([0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/,
                description: colors.magenta(`[TCP_PORT] Please enter a TCP listening port for HarperDB `),
                message: 'Invalid port.',
                default: 9925,
                required: false,
                ask: function () {
                    return newInstall || !newInstall && prompt.history('REINSTALL').value;
                }
            },
            HTTP_PORT: {
                pattern: /^([0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/,
                description: colors.magenta(`[HTTP_PORT] Please enter an HTTP listening port for HarperDB`),
                message: 'Invalid port.',
                default: 5529,
                required: false,
                ask: function () {
                    return newInstall || !newInstall && prompt.history('REINSTALL').value;
                }
            },
            HDB_ADMIN_USERNAME: {
                description: colors.magenta('[HDB_ADMIN_USERNAME] Please enter a username for the HDB_ADMIN'),
                default: 'HDB_ADMIN',
                required: true,
                ask: function () {
                    return newInstall || !newInstall && prompt.history('REINSTALL').value;
                }
            },
            HDB_ADMIN_PASSWORD: {
                description: colors.magenta('[HDB_ADMIN_PASSWORD] Please enter a password for the HDB_ADMIN'),
                hidden: true,
                required: true,
                ask: function () {
                    return newInstall || !newInstall && prompt.history('REINSTALL').value;
                }
            },
            HDB_REGISTER: {
                description: colors.magenta('[REGISTER] Would you like to register now?'),
                type: 'boolean',
                default: true,
                required: true,
                ask: function () {
                    return newInstall || !newInstall && prompt.history('REINSTALL').value;
                }
            },


        }
    };


    console.log(colors.magenta('' + fs.readFileSync(`./utility/install/ascii_logo`)));
    prompt.start();

    prompt.get(install_schema, function (err, result) {
        wizard_result = result;
        prompt.stop();
        callback(err);


    });
}

function createSettingsFile(callback) {
    var settings_file = `module.exports = {
            PROJECT_DIR : __dirname,
            HDB_ROOT: '${wizard_result.HDB_ROOT}',
            TCP_PORT: '${wizard_result.TCP_PORT}',
            HTTP_PORT:'${wizard_result.HTTP_PORT}',
            HDB_ADMIN_USERNAME: '${wizard_result.HDB_ADMIN_USERNAME}',
            HDB_ADMIN_PASSWORD: '${password.hash(wizard_result.HDB_ADMIN_PASSWORD)}'

        };`


    boot_loader.insertBootLoader(`${wizard_result.HDB_ROOT}/config/settings.js`, (err) => {
        fs.writeFile(`${wizard_result.HDB_ROOT}/config/settings.js`, settings_file, function(err, data){
            if (err) {
                callback(err);
                return;
            }
            settings = settings_file;
            callback(null, wizard_result.HDB_ROOT);
        });



    });
}



function setupService(mount_success, callback) {
    fs.readFile(`${__dirname}/utility/install/harperdb.service`, 'utf8', function (err, data) {
        var fileData = data.replace('{{project_dir}}', `${__dirname}`).replace('{{hdb_directory}}', settings.HDB_ROOT);
        fs.writeFile('/etc/systemd/system/harperdb.service', fileData, function (err, result) {

            if (err) {
                console.error(err);
                callback(err);
                return;
            }

            var terminal = spawn('bash');
            terminal.stderr.on('data', function (data) {
                //console.log('error',`Express server failed to run: ${data}`);
                console.log('' + data);
                //Here is where the error output goes
            });


            terminal.stdin.write(`sudo systemctl daemon-reload &`);
            terminal.stdin.end();

            callback(null, 'success');
            return;

        });
    });
}

