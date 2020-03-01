/***
 * @Author: Stephen Goldberg
 * @Date: 3/4/3017
 * @Description: Create the filesystem under the path root specified in hdb_path
 */

const fs = require('fs');
const path = require('path');
const terms = require('../utility/hdbTerms');
const lmdb_terms = require('../utility/lmdb/terms');

const lmdb_environment_utility = require('../utility/lmdb/environmentUtility');
const system_schema = require('../json/systemSchema');

module.exports = function (logger, hdb_path, callback) {
    const env_mngr = require('../utility/environment/environmentManager');
    let system_schema_path = path.join(hdb_path, 'schema', 'system');

    makeDirectory(logger, hdb_path);
    makeDirectory(logger, path.join(hdb_path, "backup"));
    makeDirectory(logger, path.join(hdb_path, 'trash'));
    makeDirectory(logger, path.join(hdb_path, 'keys'));
    makeDirectory(logger, path.join(hdb_path, 'log'));
    makeDirectory(logger, path.join(hdb_path, 'config'));
    makeDirectory(logger, path.join(hdb_path, 'doc'));
    makeDirectory(logger, path.join(hdb_path, 'schema'));
    makeDirectory(logger, system_schema_path);
    makeDirectory(logger, path.join(hdb_path, 'clustering'));
    makeDirectory(logger, path.join(hdb_path, 'clustering', 'transaction_log'));
    makeDirectory(logger, path.join(hdb_path, 'clustering', 'connections'));

    if(env_mngr.getDataStoreType() === terms.STORAGE_TYPES_ENUM.FILE_SYSTEM){
        createFSTables(system_schema_path, logger);
        return callback(null, 'complete');
    } else if(env_mngr.getDataStoreType() === terms.STORAGE_TYPES_ENUM.LMDB){
        createLMDBTables(system_schema_path, logger).then(()=>{
            callback(null, 'complete');
        }).catch(e=>{
            callback(e);
        });
    }
};

/**
 * creates the directory structure needed for the fs data store based on the systemSchema
 * @param schema_path
 * @param logger
 */
function createFSTables(schema_path, logger){
    let tables = Object.keys(system_schema);
    for(let x = 0; x < tables.length; x++) {
        let table_name = tables[x];
        makeDirectory(logger, path.join(schema_path, table_name));
        let attributes = system_schema[table_name].attributes;

        for(let y = 0; y < attributes.length; y++){
            makeDirectory(logger, path.join(schema_path, table_name, attributes[y].attribute));
        }
    }
}

/**
 * creates the environments & dbis needed for lmdb  based on the systemSchema
 * @param schema_path
 * @param logger
 * @returns {Promise<void>}
 */
async function createLMDBTables(schema_path, logger){
    let tables = Object.keys(system_schema);
    for(let x = 0; x < tables.length; x++) {
        let table_name = tables[x];
        let table_env;
        try {
            table_env = await lmdb_environment_utility.createEnvironment(schema_path, table_name);
        } catch(e){
            logger.error(`issue creating environment for ${terms.SYSTEM_SCHEMA_NAME}.${table_name}: ${e}`);
            throw e;
        }
        let hash_attribute = system_schema[table_name].hash_attribute;

        //create all dbis
        let attributes = system_schema[table_name].attributes;
        for(let y = 0; y < attributes.length; y++){
            let attribute_name = attributes[y].attribute;
            try {
                if(terms.TIME_STAMP_NAMES.indexOf(attribute_name) >=0){
                    await lmdb_environment_utility.createDBI(table_env, attribute_name, true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
                } else if (attribute_name === hash_attribute){
                    await lmdb_environment_utility.createDBI(table_env, attribute_name, false, lmdb_terms.DBI_KEY_TYPES.STRING, true);
                } else{
                    await lmdb_environment_utility.createDBI(table_env, attribute_name, true, lmdb_terms.DBI_KEY_TYPES.STRING, false);
                }
            } catch(e){
                logger.error(`issue creating dbi for ${terms.SYSTEM_SCHEMA_NAME}.${table_name}.${attribute_name}: ${e}`);
                throw e;
            }
        }
    }
}

function makeDirectory(logger, targetDir, {isRelativeToScript = false} = {}) {
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

