/***
 * @Author: Stephen Goldberg
 * @Date: 3/4/3017
 * @Description: Create the filesystem under the path root specified in hdb_path
 */

const fs = require('fs');
const path = require('path');
const {promisify} = require('util');
const log = require('../utility/logging/harper_logger');
const hdb_util = require('../utility/common_utils');

// Promisified functions
const p_fs_readdir = promisify(fs.readdir);

let loaded_directives = [];

module.exports = {
    mountDirectives:mountDirectives
};

async function readDirectives(hdb_path) {
    const directive_path = path.join(process.cwd(), 'installRequirements', 'directives');
    let files = await p_fs_readdir(directive_path);
    if(!files) {
        console.error(`No directive files found in path: ${directive_path}`);
        log.fatal(`No directive files found in path: ${directive_path}`);
        throw new Error(`No directive files found in path: ${directive_path}`);
    }
    for(let i = 0; i<files.length; i++) {
        let directive = require(`${files[i]}`);
        loaded_directives.push(directive);
        log.trace(`loaded directive ${files[i]}`);
    }
}

function makeDirectory(targetDir, {isRelativeToScript = false} = {}) {
    const sep = path.sep;
    const initDir = path.isAbsolute(targetDir) ? sep : '';
    const baseDir = isRelativeToScript ? __dirname : '.';

    targetDir.split(sep).reduce((parentDir, childDir) => {
        const curDir = path.resolve(baseDir, parentDir, childDir);
        try {
            if(curDir && curDir !== '/') {
                fs.mkdirSync(curDir);
                logger.info(`Directory ${curDir} created`);
            }
        } catch (err) {
            if (err.code !== 'EEXIST') {
                throw err;
            }
        }
        return curDir;
    }, initDir);
}

async function writeEnvVariables(hdb_path, variable_declarations) {

}

async function mountDirectives(hdb_path, callback) {
    await readDirectives(hdb_path);
    if(hdb_util.isEmptyOrZeroLength(loaded_directives)) {
        console.error(`No install/upgrade directives found.  Exiting.`);
        log.error(`No install/upgrade directives found.  Exiting.`);
        process.exit(1);
    }

    /*makeDirectory(hdb_path);
    makeDirectory(path.join(hdb_path, "staging"));
    makeDirectory(path.join(hdb_path, "staging/scripts"));
    makeDirectory(path.join(hdb_path, "staging/symlink_eraser"));
    makeDirectory(path.join(hdb_path, "staging/schema_op_queue"));
    makeDirectory(path.join(hdb_path, "staging/schema_op_log"));
    makeDirectory(path.join(hdb_path, "backup"));
    makeDirectory(path.join(hdb_path, "trash"));
    makeDirectory(path.join(hdb_path, "keys"));
    makeDirectory(path.join(hdb_path, "log"));
    makeDirectory(path.join(hdb_path, "config"));
    makeDirectory(path.join(hdb_path, "doc"));
    makeDirectory(path.join(hdb_path, "schema"));
    makeDirectory(path.join(hdb_path, "schema/system"));
    makeDirectory(path.join(hdb_path, "schema/system/hdb_license"));
    makeDirectory(path.join(hdb_path, "schema/system/hdb_attribute"));
    makeDirectory(path.join(hdb_path, "schema/system/hdb_schema"));
    makeDirectory(path.join(hdb_path, "schema/system/hdb_table"));
    makeDirectory(path.join(hdb_path, "schema/system/hdb_table/schema"));
    makeDirectory(path.join(hdb_path, "schema/system/hdb_table/name"));
    makeDirectory(path.join(hdb_path, "schema/system/hdb_table/hash_attribute"));
    makeDirectory(path.join(hdb_path, "schema/system/hdb_table/residence"));
    makeDirectory(path.join(hdb_path, "schema/system/hdb_user"));
    makeDirectory(path.join(hdb_path, "schema/system/hdb_role"));
    makeDirectory(path.join(hdb_path, "schema/system/hdb_queue"));
    makeDirectory(path.join(hdb_path, "schema/system/hdb_nodes"));
    callback(null, 'complete');
    */
};






