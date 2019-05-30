const run = require('./run');
const install = require('./install');
const stop = require('./stop');

const version = require('./version');
const upgrade = require('./upgrade');
const fs = require('fs');
const logger = require('../utility/logging/harper_logger');
const hdb_terms = require('../utility/hdbTerms');
const hdb_utils = require('../utility/common_utils');
const {promisify} = require('util');
const path = require('path');
const os = require('os');

const p_upgrade = promisify(upgrade.upgrade);

harperDBService();

function checkCallingUserSync() {
    let hdb_exe_path = path.join(__dirname, 'harperdb.js');
    let stats = undefined;
    try {
        stats = fs.statSync(hdb_exe_path);
    } catch(e) {
        // if we are here, we are probably running from the repo.
        logger.info(`Couldn't find the harperdb executable process.`);
        return;
    }
    let curr_user = os.userInfo();
    if(stats && stats.uid !== curr_user.uid) {
        let err_msg = `You are not the owner of the HarperDB process.  Please log in as the owner and try the command again.`;
        logger.error(err_msg);
        console.log(err_msg);
        throw new Error(err_msg);
    }
}

function harperDBService() {
    let service;

    let inBin = false;
    fs.readdir(__dirname, (err, files) => {
        if (err) {
            return logger.error(err);
        }

        if (process.argv && process.argv[2]) {
            service = process.argv[2].toLowerCase();
        }

        // check if already running, ends process if error caught.
        if(service !== hdb_terms.SERVICE_ACTIONS_ENUM.INSTALL) {
            try {
                checkCallingUserSync();
            } catch (e) {
                console.log(e.message);
                throw e;
            }
        }

        let tar_file_path = process.argv[3];
        let result = undefined;
        switch (service) {
            case hdb_terms.SERVICE_ACTIONS_ENUM.RUN:
                result = run.run();
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.INSTALL:
                install.install((err, response)=>{
                    if(err){
                        console.error(err);
                    } else {
                        console.log(response);
                    }
                });
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.REGISTER:
                // register requires a lot of imports that could fail during install, so only bring it in when needed.
                const register = require('./register');
                register.register().then((response) => {
                    console.log(response);
                }).catch((err) => {
                    console.error(err);
                });
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.STOP:
                stop.stop().then();
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.RESTART:
                stop.stop().then(
                    run.run()
                );
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
                    upgrade.startUpgrade()
                        .then(() => {
                            logger.notify('Upgrade complete');
                    })
                        .catch((err) => {
                            console.log('There was an error during the upgrade process.  Please check the logs for details.');
                            logger.error(err);
                        });
                } else {
                    upgrade.upgradeFromFilePath(tar_file_path)
                        .then(() => {
                        logger.notify('Upgrade complete');
                    })
                        .catch((err) => {
                            console.log('There was an error during the upgrade process.  Please check the logs for details.');
                            logger.error(err);
                        });
                }
                break;
            default:
                run.run();
                break;
        }
    });
}
