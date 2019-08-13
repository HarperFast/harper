'use strict';

const log = require('../../../../utility/logging/harper_logger');
const common_utils = require('../../../../utility/common_utils');
const env = require('../../../../utility/environment/environmentManager');
const unlink = require('../../../../utility/fs/unlink');
const truncate = require('truncate-utf8-bytes');

const slash_regex = /\//g;
const BASE_PATH = common_utils.buildFolderPath(env.get('HDB_ROOT'), "schema");
const HDB_HASH_FOLDER_NAME = '__hdb_hash';
const MAX_BYTES = '255';
const HDB_FILE_SUFFIX = '.hdb';
const BLOB_FOLDER_NAME = 'blob';

module.exports = deleteRecords;

async function deleteRecords(delete_obj){
    // if (common_utils.isEmptyOrZeroLength(delete_obj.records)){
    //     throw new Error('Item not found');
    // }

    let hash_attribute = null;
    try {
        hash_attribute = global.hdb_schema[delete_obj.schema][delete_obj.table].hash_attribute;
    } catch (e) {
        log.error(`could not retrieve hash attribute for schema:${delete_obj.schema} and table ${delete_obj.table}`);
        return common_utils.errorizeMessage(`hash attribute not found`);
    }

    let paths = [];
    let table_path = common_utils.buildFolderPath(BASE_PATH, delete_obj.schema, delete_obj.table);

    //generate the paths for each file to delete
    delete_obj.records.forEach((record)=>{
        Object.keys(record).forEach((attribute)=>{
            let hash_value = record[hash_attribute];
            if(!common_utils.isEmptyOrZeroLength(hash_value)) {
                paths.push(common_utils.buildFolderPath(table_path, HDB_HASH_FOLDER_NAME, attribute, `${hash_value}${HDB_FILE_SUFFIX}`));
                let stripped_value = String(record[attribute]).replace(slash_regex, '');
                stripped_value = stripped_value.length > MAX_BYTES ? common_utils.buildFolderPath(truncate(stripped_value, MAX_BYTES), BLOB_FOLDER_NAME) : stripped_value;
                paths.push(common_utils.buildFolderPath(table_path, attribute, stripped_value, `${hash_value}${HDB_FILE_SUFFIX}`));
            }
        });
    });

    try {
        await unlink(paths);
    } catch(err) {
        throw common_utils.errorizeMessage(err);
    }
}
