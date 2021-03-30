'use strict';

const hdb_util = require('../utility/common_utils');
const log = require('../utility/logging/harper_logger');
const path = require('path');
const fs = require('fs');
const terms = require('../utility/hdbTerms');


/**
 * Creates all directories specified in a directive file.
 *
 * @param hdb_base - value from HDB_ROOT in settings file
 * @param directive_paths
 */
function createRelativeDirectories(hdb_base, directive_paths) {
    if(hdb_util.isEmptyOrZeroLength(directive_paths)) {
        log.info('No upgrade directories to create.');
        return;
    }

    for(let dir_path of directive_paths) {
        // This is synchronous
        let new_dir_path = path.join(hdb_base, dir_path);
        log.info(`Creating directory ${new_dir_path}`);
        makeDirectory(new_dir_path);
    }
}

function createExplicitDirectories(directive_paths) {
    if(hdb_util.isEmptyOrZeroLength(directive_paths)) {
        log.info('No upgrade directories to create.');
        return;
    }
    for(let dir_path of directive_paths) {
        // This is synchronous
        try {
            log.info(`Creating directory ${dir_path}`);
            makeDirectory(dir_path);
        } catch(err) {
            log.error(`Error Creating path ${dir_path}.`);
            log.error(err);
            continue;
        }
    }
}

//This is synchronous to ensure everything runs in order.
/**
 * Recursively create directory specified.
 * @param targetDir - Directory to create
 * @param isRelativeToScript - Defaults to false, if true will use curr directory as the base path
 */
function makeDirectory(targetDir, {isRelativeToScript = false} = {}) {
    if(hdb_util.isEmptyOrZeroLength(targetDir)) {
        log.info('Invalid directory path.');
        return;
    }
    const sep = path.sep;
    const initDir = path.isAbsolute(targetDir) ? sep : '';
    const baseDir = isRelativeToScript ? __dirname : '.';

    targetDir.split(sep).reduce((parentDir, childDir) => {
        const curDir = path.resolve(baseDir, parentDir, childDir);
        try {
            if(curDir && curDir !== '/') {
                fs.mkdirSync(curDir, {mode: terms.HDB_FILE_PERMISSIONS});
                log.info(`Directory ${curDir} created`);
            }
        } catch (err) {
            if (err.code !== 'EEXIST') {
                throw err;
            }
        }
        return curDir;
    }, initDir);
}
