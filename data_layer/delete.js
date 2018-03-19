'use strict';

const PropertiesReader = require('properties-reader'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`),
    bulk_delete_validator = require('../validation/bulkDeleteValidator'),
    conditional_delete_validator = require('../validation/conditionalDeleteValidator'),
    search = require('./search'),
    common_utils = require('../utility/common_utils'),
    async = require('async'),
    fs = require('graceful-fs'),
    global_schema = require('../utility/globalSchema'),
    truncate = require('truncate-utf8-bytes'),
    winston = require('../utility/logging/winston_logger');

hdb_properties.append(hdb_properties.get('settings_path'));

const slash_regex =  /\//g;
const base_path = common_utils.buildFolderPath(hdb_properties.get('HDB_ROOT'), "schema"),
    HDB_HASH_FOLDER_NAME = '__hdb_hash',
    BLOB_FOLDER_NAME = 'blob',
    MAX_BYTES = '255',
    ENOENT_ERROR_CODE = 'ENOENT',
    SUCCESS_MESSAGE = 'records successfully deleted';;


module.exports ={
    delete: deleteRecord,
    conditionalDelete:conditionalDelete,
    deleteRecords: deleteRecords
};

/**
 * Delete a record and unlink all attributes associated with that record.
 * @param delete_object
 * @param callback
 */
function deleteRecord(delete_object, callback){
    try {
        let validation = bulk_delete_validator(delete_object);
        if (validation) {
            callback(validation);
            return;
        }

        let search_obj =
            {
                schema: delete_object.schema,
                table: delete_object.table,
                hash_values: delete_object.hash_values,
                get_attributes: ['*']
            };

        async.waterfall([
            global_schema.getTableSchema.bind(null, delete_object.schema, delete_object.table),
            (table_info, callback) => {
                callback();
            },
            search.searchByHash.bind(null, search_obj),
            deleteRecords.bind(null, delete_object.schema, delete_object.table)
        ], (err, data) => {
            if (err) {
                callback(err);
                return;
            }

            callback(null, SUCCESS_MESSAGE);
        });
    } catch(e){
        callback(e);
    }
}

function conditionalDelete(delete_object, callback){
    try {
        let validation = conditional_delete_validator(delete_object);
        if (validation) {
            callback(validation);
            return;
        }

        async.waterfall([
            global_schema.getTableSchema.bind(null, delete_object.schema, delete_object.table),
            (table_info, callback) => {
                callback(null, delete_object.conditions, table_info);
            },
            search.multiConditionSearch,
            (ids, callback) => {
                let delete_wrapper = {
                    schema: delete_object.schema,
                    table: delete_object.table,
                    hash_values: ids
                };

                callback(null, delete_wrapper);
            },
            deleteRecord
        ], (err) => {
            if (err) {
                callback(err);
                return;
            }

            callback(null, SUCCESS_MESSAGE);
        });
    } catch(e) {
        callback(e);
    }
}

function deleteRecords(schema, table, records, callback){
    if(common_utils.isEmptyOrZeroLength(records)){
        callback("Item not found!");
        return;
    }

    let hash_attribute = global.hdb_schema[schema][table].hash_attribute;
    let paths = [];
    let table_path = common_utils.buildFolderPath(base_path, schema, table);

    //generate the paths for each file to delete
    records.forEach((record)=>{
        Object.keys(record).forEach((attribute)=>{
            let hash_value = record[hash_attribute];
            paths.push(common_utils.buildFolderPath(table_path, HDB_HASH_FOLDER_NAME, attribute, `${hash_value}.hdb`));
            let stripped_value = String(record[attribute]).replace(slash_regex, '');
            stripped_value = stripped_value.length > MAX_BYTES ? common_utils.buildFolderPath(truncate(stripped_value, MAX_BYTES), BLOB_FOLDER_NAME) : stripped_value;
            paths.push(common_utils.buildFolderPath(table_path, attribute, stripped_value, `${hash_value}.hdb`));
        });
    });

    async.each(paths, (path, caller)=>{
        fs.unlink(path, (err)=>{
            if(err){
                if(err.code === ENOENT_ERROR_CODE){
                    return caller();
                }
                winston.error(err);
                return caller(err);
            }

            return caller();
        });
    }, (err)=>{
        if(err){
            return callback(err);
        }

        callback();
    });
}