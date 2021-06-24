/***
 * @Author: Stephen Goldberg
 * @Date: 3/4/3017
 * @Description: Create the filesystem under the path root specified in hdb_path
 */

const fs = require('fs');
const path = require('path');
const terms = require('../utility/hdbTerms');

const lmdb_environment_utility = require('../utility/lmdb/environmentUtility');
const system_schema = require('../json/systemSchema');

module.exports = function (logger, hdb_path, callback) {
    const env_mngr = require('../utility/environment/environmentManager');
    let system_schema_path = path.join(hdb_path, terms.SCHEMA_DIR_NAME, terms.SYSTEM_SCHEMA_NAME);
    let transactions_path = path.join(hdb_path, terms.TRANSACTIONS_DIR_NAME);

    makeDirectory(logger, hdb_path);
    makeDirectory(logger, path.join(hdb_path, "backup"));
    makeDirectory(logger, path.join(hdb_path, 'trash'));
    makeDirectory(logger, path.join(hdb_path, 'keys'));
    makeDirectory(logger, path.join(hdb_path, 'keys', terms.LICENSE_FILE_NAME));
    makeDirectory(logger, path.join(hdb_path, 'log'));
    makeDirectory(logger, path.join(hdb_path, 'config'));
    makeDirectory(logger, path.join(hdb_path, 'doc'));
    makeDirectory(logger, path.join(hdb_path, 'schema'));
    makeDirectory(logger, system_schema_path);
    makeDirectory(logger, path.join(hdb_path, terms.TRANSACTIONS_DIR_NAME));
    makeDirectory(logger, path.join(hdb_path, 'clustering'));
    makeDirectory(logger, path.join(hdb_path, 'clustering', 'transaction_log'));
    makeDirectory(logger, path.join(hdb_path, 'clustering', 'connections'));

    env_mngr.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, hdb_path);
    createLMDBTables(system_schema_path, transactions_path, logger).then(()=>{
        callback(null, 'complete');
    }).catch(e=>{
        callback(e);
    });
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
        makeDirectory(logger, path.join(schema_path.toString(), table_name.toString()));
        let attributes = system_schema[table_name].attributes;

        for(let y = 0; y < attributes.length; y++){
            makeDirectory(logger, path.join(schema_path, table_name, attributes[y].attribute));
        }
    }
}

/**
 * creates the environments & dbis needed for lmdb  based on the systemSchema
 * @param schema_path
 * @param transactions_path
 * @param logger
 * @returns {Promise<void>}
 */
async function createLMDBTables(schema_path, transactions_path, logger){
    // eslint-disable-next-line global-require
    const lmdb_create_table = require('../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateTable');
    // eslint-disable-next-line global-require
    const CreateTableObject = require('../data_layer/CreateTableObject');

    let tables = Object.keys(system_schema);

    for(let x = 0; x < tables.length; x++) {
        let table_name = tables[x];
        let table_env;
        let hash_attribute = system_schema[table_name].hash_attribute;
        try{
            let create_table = new CreateTableObject(terms.SYSTEM_SCHEMA_NAME, table_name, hash_attribute);
            await lmdb_create_table(undefined, create_table);
            table_env = await lmdb_environment_utility.openEnvironment(schema_path, table_name);
        }catch(e){
            logger.error(`issue creating environment for ${terms.SYSTEM_SCHEMA_NAME}.${table_name}: ${e}`);
            throw e;
        }

        //create all dbis
        let attributes = system_schema[table_name].attributes;
        for(let y = 0; y < attributes.length; y++){
            let attribute_name = attributes[y].attribute;
            try {
                if(terms.TIME_STAMP_NAMES.indexOf(attribute_name) >=0){
                    await lmdb_environment_utility.createDBI(table_env, attribute_name, true);
                } else if (attribute_name === hash_attribute){
                    await lmdb_environment_utility.createDBI(table_env, attribute_name, false, true);
                } else{
                    await lmdb_environment_utility.createDBI(table_env, attribute_name, true, false);
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

