/***
 * @Author: Stephen Goldberg
 * @Date: 3/4/3017
 * @Description: Create the filesystem under the path root specified in hdb_path
 */

const fs = require('fs');
const path = require('path');
const terms = require('../utility/hdbTerms');

module.exports = function (logger, hdb_path, callback) {

    function makeDirectory(targetDir, {isRelativeToScript = false} = {}) {
        const sep = path.sep;
        const initDir = path.isAbsolute(targetDir) ? sep : '';
        const baseDir = isRelativeToScript ? __dirname : '.';

        targetDir.split(sep).reduce((parentDir, childDir) => {
            const curDir = path.resolve(baseDir, parentDir, childDir);
            try {
                if(curDir && curDir !== '/') {
                    fs.mkdirSync(curDir, {mode: terms.HDB_FILE_PERMISSIONS});
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

    makeDirectory(hdb_path);
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
    makeDirectory(path.join(hdb_path, "schema/system/hdb_nodes"));
    makeDirectory(path.join(hdb_path, "schema/system/hdb_job"));
    makeDirectory(path.join(hdb_path, "clustering"));
    makeDirectory(path.join(hdb_path, "clustering", "transaction_log"));
    makeDirectory(path.join(hdb_path, "clustering", "connections"));
    callback(null, 'complete');
};

