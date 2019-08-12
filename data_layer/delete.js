"use strict";
const env = require('../utility/environment/environmentManager');
const bulk_delete_validator = require('../validation/bulkDeleteValidator');
const conditional_delete_validator = require('../validation/conditionalDeleteValidator');
const search = require('./search');
const common_utils = require('../utility/common_utils');
const async = require('async');
const fs = require('graceful-fs');
const global_schema = require('../utility/globalSchema');
const truncate = require('truncate-utf8-bytes');
const path = require('path');
const moment = require('moment');
const harper_logger = require('../utility/logging/harper_logger');
const { promisify, callbackify } = require('util');
const unlink = require('../utility/fs/unlink');
const c_unlink = callbackify(unlink);
const terms = require('../utility/hdbTerms');

const slash_regex = /\//g;
const BASE_PATH = common_utils.buildFolderPath(env.get('HDB_ROOT'), "schema");
const HDB_HASH_FOLDER_NAME = '__hdb_hash';
const BLOB_FOLDER_NAME = 'blob';
const MAX_BYTES = '255';
const ENOENT_ERROR_CODE = 'ENOENT';
const SUCCESS_MESSAGE = 'records successfully deleted';
const HDB_FILE_SUFFIX = '.hdb';
const MOMENT_UNIX_TIMESTAMP_FLAG = 'x';
const SYSTEM_SCHEMA_NAME = 'system';

// Promisified functions
const p_fs_stat = promisify(fs.stat);
const p_fs_readdir = promisify(fs.readdir);
const p_fs_unlink = promisify(fs.unlink);
const p_delete_record = promisify(deleteRecord);
const p_fs_rmdir = promisify(fs.rmdir);

module.exports = {
    delete: deleteRecord,
    conditionalDelete: conditionalDelete,
    deleteRecords: deleteRecords,
    deleteFilesBefore: deleteFilesBefore
};

/**
 * Deletes files that have a system date before the date parameter.  Note this does not technically delete the values from the database,
 * so if clustering is enabled values added will still remain in a parent node.  This serves only to remove files for
 * devices that have a small amount of disk space.
 *
 * @param json_body - the request passed from chooseOperation.
 * @param callback
 */
async function deleteFilesBefore(json_body) {

    if(common_utils.isEmptyOrZeroLength(json_body.date)) {
        throw new Error("Invalid date.");
    }
    let parsed_date = moment(json_body.date, moment.ISO_8601);
    if(!parsed_date.isValid()) {
        throw new Error("Invalid date, must be in ISO-8601 format (YYYY-MM-DD).");
    }
    if(common_utils.isEmptyOrZeroLength(json_body.schema)) {
        throw new Error("Invalid schema.");
    }
    let schema = json_body.schema;
    if(common_utils.isEmptyOrZeroLength(json_body.table)) {
        throw new Error("Invalid table.");
    }
    let table = json_body.table;
    let dir_path = common_utils.buildFolderPath(BASE_PATH, schema, table);

    await deleteFilesInPath(schema, table, dir_path, parsed_date).catch(function caughtError(err) {
        harper_logger.error(`There was an error deleting files by date: ${err}`);
        throw new Error(`There was an error deleting files by date: ${err}`);
    });
    harper_logger.info(`Finished deleting files before ${json_body.date}`);
}

/**
 * Starting at the path passed as a parameter, look at each file and compare it to the date parameter.  If the file is
 * older than the date, delete it.
 * @param schema - The schema to check for files that can be removed based on the date.
 * @param table - The table to check for files that can be removed.
 * @param dir_path - The path to search for files
 * @param date - the date as a momentjs object.
 * @returns {Promise<*>}
 */
async function deleteFilesInPath(schema, table, dir_path, date) {
    if(common_utils.isEmptyOrZeroLength(dir_path)) {
        harper_logger.error(`directory path ${dir_path} is invalid.`);
        return;
    }
    if(!date || !moment.isMoment(date) || !date.isValid()) {
        harper_logger.error(`date ${date} is invalid.`);
        return;
    }
    if(common_utils.isEmptyOrZeroLength(schema) || schema === SYSTEM_SCHEMA_NAME) {
        harper_logger.error(`Schema ${schema} is invalid.`);
        return;
    }
    if(common_utils.isEmptyOrZeroLength(table)) {
        harper_logger.error(`Table ${table} is invalid.`);
        return;
    }
    let hash_attribute = undefined;
    try {
        hash_attribute = global.hdb_schema[schema][table].hash_attribute;
    } catch (e) {
        harper_logger.error(`Schema ${schema} and table ${table} attributes were not found.`);
        return;
    }
    let doesExist = await doesDirectoryExist(dir_path).catch(e => {
        harper_logger.info(`There was a problem checking directory ${dir_path}`);
    });
    if (!doesExist) {
        let message = "Invalid Directory Path.";
        harper_logger.info(message);
        return common_utils.errorizeMessage(message);
    }

    let found_files = [];
    await inspectHashAttributeDir(date, path.join(dir_path, hash_attribute), found_files).catch(e => {
        harper_logger.info(`There was a problem getting attributes for table directory ${dir_path}`);
    });
    if (common_utils.isEmptyOrZeroLength(found_files)) {
        let message = "No files found";
        harper_logger.info(message);
        return message;
    }
    await removeFiles(schema, table, hash_attribute, found_files).catch( e => {
        harper_logger.info(`There was a problem removing files for Schema ${schema} and table ${table}`);
    });

}

/**
 * Internal function used to verify a given directory path exists.
 * @param dir_path - directory path to stat
 * @returns {*}
 */
async function doesDirectoryExist(dir_path) {
    if(common_utils.isEmptyOrZeroLength(dir_path)) {
        harper_logger.info('not a valid directory path');
        return false;
    }
    try {
        harper_logger.trace(`Checking directory ${dir_path}`);
        let stats = await p_fs_stat(dir_path);
        return stats && stats.isDirectory();
    } catch (e) {
        harper_logger.info(e);
        return false;
    }
}

/**
 * Removes all files which had a last modified date less than the date parameter by calling deleteRecord.
 * @param schema - The schema to remove files in .
 * @param table - The table to remove files in.
 * @param hash_attribute - The hash attribute of the table.
 * @param ids_to_remove - Array that contains the IDs of the records that should be removed in the schema/table.
 */
async function removeFiles(schema, table, hash_attribute, ids_to_remove) {
    let records_to_remove = {"operation": "delete",
        "table": `${table}`,
        "schema": `${schema}`,
        "hash_values": ids_to_remove
    };

    try {
        await p_delete_record(records_to_remove);
        await removeIDFiles(schema, table, hash_attribute, ids_to_remove);
    } catch (e) {
        harper_logger.info(`There was a problem deleting records: ${e}`);
        return common_utils.errorizeMessage(e);
    }
}

/**
 * Removes all id files specified in the hash_ids parameter.  The remove workflow leaves these files as part of
 * the journal.  Time To Live requires us to remove these files.
 * @param schema - The schema to remove the files from.
 * @param table - The table to remove the files from.
 * @param hash_ids - An array containing the ids for hash directories that need to be removed.
 * @returns {Promise<void>}
 */
async function removeIDFiles(schema, table, hash_attribute, hash_ids) {
    if(common_utils.isEmptyOrZeroLength(schema) || schema === SYSTEM_SCHEMA_NAME) {
        harper_logger.info(`Invalid schema name.`);
        return;
    }
    if(common_utils.isEmptyOrZeroLength(table)) {
        harper_logger.info(`Invalid table name.`);
        return;
    }
    if(common_utils.isEmptyOrZeroLength(hash_ids)) {
        return;
    }
    for(let i = 0; i<hash_ids.length; i++) {
        let curr_id_path = undefined;
        let files_in_dir = [];
        try {
            curr_id_path = path.join(BASE_PATH, schema, table, hash_attribute, hash_ids[i]);
            files_in_dir = await p_fs_readdir(curr_id_path);
        } catch(e) {
            harper_logger.error(`There was a problem reading dir ${curr_id_path}.  ${e}`);
            continue;
        }
        if(common_utils.isEmptyOrZeroLength(files_in_dir)) {
            continue;
        }
        for(let file_num = 0; file_num < files_in_dir.length; file_num++) {
            try {
                harper_logger.trace(`trying to unlink file ${files_in_dir[file_num]}`);
                await p_fs_unlink(path.join(curr_id_path, files_in_dir[file_num]));
            } catch(e) {
                harper_logger.error(`There was a problem unlinking file ${files_in_dir[file_num]}.  ${e}`);
            }
        }
        try {
            await p_fs_rmdir(curr_id_path);
        } catch(e) {
            harper_logger.error(`There was a problem removing directory ${curr_id_path}.  ${e}`);
        }
    }
}

/**
 * Inspects a specified dir_path which should be the path to the hash attribute of a record.  It will compare the
 * timestamped file names of the records inside with the date_unix_ms paramter.  If the record has no times greater than
 * the date_unix_ms parameter, the id will be marked to be deleted.
 * @param date_unix_ms - The date to be compared to the files found in dir_path.  Should be passed as a moment object.
 * @param dir_path - Path of the hash attribute directory.
 * @param hash_attributes_to_remove - Array that will be filled in with found ids.
 * @returns {Promise<void>}
 */
async function inspectHashAttributeDir(date_unix_ms, dir_path, hash_attributes_to_remove) {

    let found_dirs = [];
    try {
        if (!(date_unix_ms) || !moment(date_unix_ms).isValid()) {
            harper_logger.info(`An invalid date ${date_unix_ms} was passed `);
            return;
        }
    } catch (e) {
        harper_logger.error(e);
    }
    await getDirectoriesInPath(dir_path, found_dirs, date_unix_ms).catch(e => {
        harper_logger.info(`There was a problem inspecting the hash attribute dir ${dir_path}`);
    });
    if(!hash_attributes_to_remove) {
        harper_logger.info(`An invalid array was passed.`);
        return;
    }
    if(common_utils.isEmptyOrZeroLength(found_dirs)) {
        harper_logger.trace(`No hash directories were found to remove.`);
        return;
    }
    for(let curr_dir in found_dirs) {
        let files_in_dir = await p_fs_readdir(found_dirs[curr_dir]);
        if(common_utils.isEmptyOrZeroLength(files_in_dir)) {
            continue;
        }
        let latest_file = undefined;
        if(files_in_dir.length === 1) {
            latest_file = files_in_dir[0];
        } else {
            for(let i = 0; i<files_in_dir.length; i++) {
                // if we find any files that have a time greater than the date_unix_mx, then we know there has been
                // an update more recent than the time, so we should not remove this record.
                if(!isFileTimeBeforeParameterTime(date_unix_ms, files_in_dir[i])) {
                    latest_file = undefined;
                    break;
                } else {
                    latest_file = files_in_dir[i];
                }
            }
        }
        if(!common_utils.isEmptyOrZeroLength(latest_file) && isFileTimeBeforeParameterTime(date_unix_ms, latest_file)) {
            // The ID of the record should be the last /<TEXT> part of the path.  Pull the ID and remove the file.
            let dir_path = (found_dirs[curr_dir]);
            let id = dir_path.substring(dir_path.lastIndexOf('/')+1, dir_path.length);
            hash_attributes_to_remove.push(id);
        }
    }
}

/**
 * Converts strings of unix time stamps to a moment object.
 * @param date_val - A string with a unix ms time stamp as the value.
 * @returns {*} - A moment object.
 */
function convertUnixStringToMoment(date_val) {
    try {
        return moment(common_utils.stripFileExtension(date_val), MOMENT_UNIX_TIMESTAMP_FLAG);
    } catch(e) {
        harper_logger.info("had problem parsing file time" + e);
        return null;
    }
}

/**
 * Compares 2 dates to see if the file_name date is before the parameter date.  The function will strip off
 * the .hdb extension and convert it to a momentjs object before comparing dates.  The function does NOT make sure
 * the file_name param has a .hdb extension.
 * @param parameter_date - date as a unix epoc number.
 * @param file_name - File name being compared.
 * @returns {*|boolean}
 */
function isFileTimeBeforeParameterTime(parameter_date, file_name) {
    if(!parameter_date || (typeof parameter_date) === "string") {
        harper_logger.info(`invalid date passed as parameter`);
        return false;
    }
    if(common_utils.isEmptyOrZeroLength(file_name)) {
        harper_logger.info(`invalid file name passed as parameter`);
        return false;
    }
    let parsed_time = convertUnixStringToMoment(file_name);
    return ( (parsed_time && parsed_time.isValid()) && parsed_time.isBefore(parameter_date));
}

/**
 * fills in the found_dirs parameter with found directories.
 * @param dirPath - path to find directories for.
 * @param found_dirs - An array of directory paths.
 * @param date_unix_ms - The date to compare files found in dirPath.
 */
async function getDirectoriesInPath(dirPath, found_dirs, date_unix_ms) {

    if(!(date_unix_ms) || !moment(date_unix_ms).isValid()) {
        harper_logger.info(`An invalid date ${date_unix_ms} was passed `);
        return;
    }
    let list = undefined;
    try {
        list = await p_fs_readdir(dirPath);
    } catch (e) {
        harper_logger.info(`Specified Directory path ${dirPath} does not exist.`);
        return;
    }
    if(!list) { return; }

    for(let found in list) {
        if(list[found] === HDB_HASH_FOLDER_NAME) {
            continue;
        }
        let file = path.resolve(dirPath, list[found]);
        let stats = undefined;
        try {
            stats = await p_fs_stat(file);
        } catch(e) {
            harper_logger.info(`Had trouble getting stats for file ${file}.`);
            return;
        }
        if (stats && stats.isDirectory() && stats.mtimeMs < date_unix_ms.valueOf()) {
            try {
                found_dirs.push(file);
                await getDirectoriesInPath(file, found_dirs, date_unix_ms);
            } catch(e) {
                harper_logger.info(`Had trouble getting files for directory ${file}.`);
                return;
            }
        }
    }
}

/**
 * Delete a record and unlink all attributes associated with that record.
 * @param delete_object
 * @param callback
 */
function deleteRecord(delete_object, callback){
    try {
        let validation = bulk_delete_validator(delete_object);
        if (validation) {
            return callback(validation);
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
        ], (err) => {
            if (err) {
                return callback(err);
            }

            if(delete_object.schema !== 'system') {
                let delete_msg = common_utils.getClusterMessage(terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
                delete_msg.transaction = delete_object;
                common_utils.sendTransactionToSocketCluster(`${delete_object.schema}:${delete_object.table}`, delete_msg);
            }

            return callback(null, SUCCESS_MESSAGE);
        });
    } catch(e){
        return callback(e);
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
        return callback(common_utils.errorizeMessage("Item not found!"));
    }
    let hash_attribute = null;
    try {
        hash_attribute = global.hdb_schema[schema][table].hash_attribute;
    } catch (e) {
        harper_logger.error(`could not retrieve hash attribute for schema:${schema} and table ${table}`);
        return callback(common_utils.errorizeMessage(`hash attribute not found`));
    }
    let paths = [];
    let table_path = common_utils.buildFolderPath(BASE_PATH, schema, table);

    //generate the paths for each file to delete
    records.forEach((record)=>{
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

    c_unlink(paths, (err)=>{
        if(err){
            return callback(common_utils.errorizeMessage(err));
        }

        return callback();
    });
}