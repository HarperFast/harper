const run = require('./run');
const install = require('./install');
const stop = require('./stop');
const register = require('./register');
const version = require('./version');
const upgrade = require('./upgrade');
const fs = require('fs');
const logger = require('../utility/logging/harper_logger');
const {promisify} = require('util');

const p_upgrade = promisify(upgrade.upgrade);

harperDBService();

function harperDBService() {
    let service;
    let currentDir_tokens = process.cwd().split('/');
    if (currentDir_tokens[currentDir_tokens.length - 1] != 'bin') {
        return console.error('You must run harperdb from HDB_HOME/bin');
    }
    
    let inBin = false;
    fs.readdir(process.cwd(), (err, files) => {
        if (err) {
            return logger.error(err);
        }

        for (f in files) {
            if (files[f] === 'harperdb.js' || files[f] === 'harperdb_macOS' || files[f] === 'harperdb') {
                inBin = true;
            }
        }

        if (!inBin) {
            return console.error('You must run harperdb from HDB_HOME/bin');
        }

        if (process.argv && process.argv[2]) {
            service = process.argv[2].toLowerCase();
        }
        let curr_version = process.argv[3];
        let result = undefined;
        switch (service) {
            case "run":
                result = run.run();
                break;
            case "install":            
                install.install();
                break;
            case "register":
                register.register();
                break;
            case "stop":
                stop.stop(function(){});
                break;
            case "restart":
                stop.stop(function () {
                    run.run();
                });
                break;
            case "version":
                version.printVersion();
                break;
            case "upgrade":
                logger.setLogLevel(logger.INFO);
                p_upgrade()
                    .then( () => {
                        // all done, no-op
                        console.log(`Upgrade is complete.`);
                    })
                    .catch((e) => {
                        logger.error(`Got an error during upgrade ${e}`);
                    });
                break;
            case "upgrade_extern":
                logger.setLogLevel(logger.INFO);
                upgrade.upgradeExternal(curr_version);
                break;
            default:
                run.run();
                break;
        }
    });
}
