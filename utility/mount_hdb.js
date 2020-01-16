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
    makeDirectory(path.join(hdb_path, "backup"));
    makeDirectory(path.join(hdb_path, 'trash'));
    makeDirectory(path.join(hdb_path, 'keys'));
    makeDirectory(path.join(hdb_path, 'log'));
    makeDirectory(path.join(hdb_path, 'config'));
    makeDirectory(path.join(hdb_path, 'doc'));
    makeDirectory(path.join(hdb_path, 'schema'));
    makeDirectory(path.join(hdb_path, 'schema/system'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_license'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_attribute'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_schema'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_schema/name'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_schema/createddate'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_schema/__hdb_hash/name'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_schema/__hdb_hash/createddate'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_table'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_table/id'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_table/schema'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_table/name'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_table/hash_attribute'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_table/residence'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_table/__hdb_hash/id'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_table/__hdb_hash/name'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_table/__hdb_hash/hash_attribute'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_table/__hdb_hash/schema'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_table/__hdb_hash/residence'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_user'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_role'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_nodes'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_nodes/host'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_nodes/__hdb_hash/host'));
    makeDirectory(path.join(hdb_path, 'schema/system/hdb_job'));
    makeDirectory(path.join(hdb_path, 'clustering'));
    makeDirectory(path.join(hdb_path, 'clustering', 'transaction_log'));
    makeDirectory(path.join(hdb_path, 'clustering', 'connections'));
    callback(null, 'complete');
};

