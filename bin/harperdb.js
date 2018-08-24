const run = require('./run');
const install = require('./install');
const stop = require('./stop');
const register = require('./register');
const version = require('./version');
const upgrade = require('./upgrade');
const fs = require('fs');
const logger = require('../utility/logging/harper_logger');
const hdb_terms = require('../utility/hdbTerms');
const hdb_utils = require('../utility/common_utils');
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

        let tar_file_path = process.argv[3];
        let result = undefined;
        switch (service) {
            case hdb_terms.SERVICE_ACTIONS_ENUM.RUN:
                result = run.run();
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.INSTALL:
                install.install();
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.REGISTER:
                register.register();
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.STOP:
                stop.stop(function(){});
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.RESTART:
                stop.stop(function () {
                    run.run();
                });
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.VERSION:
                version.printVersion();
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.UPGRADE:
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
            case hdb_terms.SERVICE_ACTIONS_ENUM.UPGRADE_EXTERN:
                logger.setLogLevel(logger.INFO);

                if(hdb_utils.isEmptyOrZeroLength(tar_file_path)) {
                    upgrade.startUpgrade();
                } else {
                    upgrade.upgradeFromFilePath(tar_file_path);
                }

                break;
            default:
                run.run();
                break;
        }
    });
}
