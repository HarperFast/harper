'use strict';

const fsSearchByHash = require('./fsSearchByHash');
const getBasePath = require('../fsUtility/getBasePath');
const log = require('../../../../utility/logging/harper_logger');
const common_utils = require('../../../../utility/common_utils');
const unlink = require('../../../../utility/fs/unlink');
const terms = require('../../../../utility/hdbTerms');
const hdb_utils = require('../../../../utility/common_utils');
const truncate = require('truncate-utf8-bytes');

const slash_regex = /\//g;
const MAX_BYTES = '255';

module.exports = deleteRecords;

async function deleteRecords(delete_obj){
    let hash_attribute = null;

    try {
        if (!delete_obj.records) {
            let search_object = {
                schema: delete_obj.schema,
                table: delete_obj.table,
                hash_values: delete_obj.hash_values,
                get_attributes: ['*']
            };
            delete_obj.records = await fsSearchByHash(search_object);

            if (common_utils.isEmptyOrZeroLength(delete_obj.records)){
                throw new Error('Item not found');
            }
        }
    } catch(err) {
        log.error(err);
        throw err;
    }

    hash_attribute = global.hdb_schema[delete_obj.schema][delete_obj.table].hash_attribute;
    if (hdb_utils.isEmpty(hash_attribute)) {
        log.error(`could not retrieve hash attribute for schema:${delete_obj.schema} and table ${delete_obj.table}`);
        throw new Error(`hash attribute not found`);
    }

    let paths = [];
    let table_path = common_utils.buildFolderPath(getBasePath(), delete_obj.schema, delete_obj.table);

    // Generate the paths for each file to delete
    delete_obj.records.forEach((record)=>{
        Object.keys(record).forEach((attribute)=>{
            let hash_value = record[hash_attribute];
            if(!common_utils.isEmptyOrZeroLength(hash_value)) {
                paths.push(common_utils.buildFolderPath(table_path, terms.HASH_FOLDER_NAME, attribute, `${hash_value}${terms.HDB_FILE_SUFFIX}`));
                let stripped_value = String(record[attribute]).replace(slash_regex, '');
                stripped_value = stripped_value.length > MAX_BYTES ? common_utils.buildFolderPath(truncate(stripped_value, MAX_BYTES), terms.BLOB_FOLDER_NAME) : stripped_value;
                paths.push(common_utils.buildFolderPath(table_path, attribute, stripped_value, `${hash_value}${terms.HDB_FILE_SUFFIX}`));
            }
        });
    });

    try {
        await unlink(paths);
    } catch(err) {
        log.error(err);
        throw common_utils.errorizeMessage(err);
    }
}
