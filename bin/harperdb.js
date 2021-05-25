#!/usr/bin/env node
'use strict';
const run = require('./run');
const install = require('./install');
const stop = require('./stop');

const version = require('./version');
const upgrade = require('./upgrade');
const fs = require('fs');
const logger = require('../utility/logging/harper_logger');
const hdb_terms = require('../utility/hdbTerms');
const path = require('path');
const os = require('os');

harperDBService();

function checkCallingUserSync() {
    let hdb_exe_path = path.join(__dirname, `harperdb.${hdb_terms.CODE_EXTENSION}`);
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

        let result = undefined;
        switch (service) {
            case hdb_terms.SERVICE_ACTIONS_ENUM.RUN:
                result = run.run();
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.INSTALL:
                install.install((install_err, response)=>{
                    if(install_err){
                        console.error(install_err);
                    } else {
                        console.log(response);
                        run.run();
                    }
                });
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.REGISTER:
                // register requires a lot of imports that could fail during install, so only bring it in when needed.
                const register = require('./register');
                register.register().then((response) => {
                    console.log(response);
                }).catch((register_err) => {
                    console.error(register_err);
                });
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.STOP:
                stop.stop().then().catch((stop_err) => {
                    console.error(stop_err);
                });
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.RESTART:
                stop.stop().then(()=> {
                    run.run();
                }).catch((restart_err) => {
                    console.error('There was an error stopping harperdb.  Please stop manually with harperdb stop and start again.');
                    process.exit(1);
                });
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.VERSION:
                version.printVersion();
                break;
            case hdb_terms.SERVICE_ACTIONS_ENUM.UPGRADE:
                logger.setLogLevel(logger.INFO);
                upgrade.upgrade(null)
                    .then(() => {
                        // all done, no-op
                        console.log(`Your instance of HDB is up to date!`);
                    })
                    .catch((e) => {
                        logger.error(`Got an error during upgrade ${e}`);
                    });
                break;
            default:
                run.run();
                break;
        }
    });
}
