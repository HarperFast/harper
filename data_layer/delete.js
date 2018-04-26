"use strict";
const PropertiesReader = require('properties-reader');
const bulk_delete_validator = require('../validation/bulkDeleteValidator');
const conditional_delete_validator = require('../validation/conditionalDeleteValidator');
const search = require('./search');
const common_utils = require('../utility/common_utils');
const async = require('async');
const fs = require('graceful-fs');
const global_schema = require('../utility/globalSchema');
const truncate = require('truncate-utf8-bytes');
const moment = require('moment');
const path = require('path');
const harper_logger = require('../utility/logging/harper_logger');
const { promisify } = require('util');

let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));
const slash_regex =  /\//g;
const BASE_PATH = common_utils.buildFolderPath(hdb_properties.get('HDB_ROOT'), "schema");
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
    conditionalDelete:conditionalDelete,
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
function deleteFilesBefore(json_body, callback) {

    if(common_utils.isEmptyOrZeroLength(json_body.date)) {
        return callback(common_utils.errorizeMessage("Invalid date."), null);
    }
    let parsed_date = moment(json_body.date, moment.ISO_8601);
    if(!parsed_date.isValid()) {
        return callback(common_utils.errorizeMessage("Invalid date, must be in ISO-8601 format."));
    }
    if(common_utils.isEmptyOrZeroLength(json_body.schema)) {
        return callback(common_utils.errorizeMessage("Invalid schema."), null);
    }
    let schema = json_body.schema;
    if(common_utils.isEmptyOrZeroLength(json_body.table)) {
        return callback(common_utils.errorizeMessage("Invalid table."), null);
    }
    let table = json_body.table;

    let dir_path = common_utils.buildFolderPath(BASE_PATH, schema, table);
    let deleted_file_count = 0;

    deleteFilesInPath(schema, table, dir_path, parsed_date).then( val => {
        deleted_file_count = val;
        let message = `Deleted ${deleted_file_count} files`;
        return callback(null, message);
    }).catch(function caughtError(err) {
        harper_logger.error(`There was an error deleting files by date: ${err}`);
        return callback(err, null);
    });
};

/**
 * Starting at the path passed as a parameter, look at each file and compare it to the date parameter.  If the file is
 * older than the date, delete it.
 * @param dir_path - The path to search for files
 * @param date - the date as a momentjs object.
 * @returns {Promise<*>}
 */
async function deleteFilesInPath(schema, table, dir_path, date) {
    let filesRemoved = 0;
    if(common_utils.isEmptyOrZeroLength(dir_path)) {
        harper_logger.error(`directory path ${dir_path} is invalid.`);
        return filesRemoved;
    }
    if(!date || !date.isValid()) {
        harper_logger.error(`date ${date} is invalid.`);
        return filesRemoved;
    }
    try {
        let hash_attribute = global.hdb_schema[schema][table].hash_attribute;
        let doesExist = await doesDirectoryExist(dir_path);
        if (!doesExist) {
            let message = "Invalid Directory Path.";
            harper_logger.info(message);
            return common_utils.errorizeMessage(message);
        }

        let found_files = [];
        await inspectHashAttributeDir(date, path.join(dir_path, hash_attribute), hash_attribute, found_files);
        if (common_utils.isEmptyOrZeroLength(found_files)) {
            let message = "No files found";
            harper_logger.info(message);
            return message;
        }
        filesRemoved = await removeFiles(schema, table, hash_attribute, found_files);
        return filesRemoved;
    } catch (e) {
        harper_logger.error(`There was an error deleting files by date: ${e}`);
        return filesRemoved;
    }
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
        let stats = await p_fs_stat(dir_path);
        if(stats && stats.isDirectory()) {
            return true;
        } else {
            return false;
        }
    } catch (e) {
        harper_logger.info(e);
        return false;
    }
};

/**
 * Removes all files which had a last modified date less than the date parameter.
 * @param date - A date passed as a moment.js date object.
 * @param files - An object key,value map of file names and stats <file_name_key, fs_stats>.  This should be a "pure"
 * key/value object created via Object.create(null). We don't want object prototype keys so we can avoid any name collisions.
 */
async function removeFiles(schema, table, hash_attribute, hashes_to_remove) {
    let records_to_remove = {"operation": "delete",
        "table": `${table}`,
        "schema": `${schema}`,
        "hash_values": hashes_to_remove
    };

    //TODO: HERE.  Getting an ID of 0 in hashes_to_remove which is suspicious.  Otherwise call removeRecord.
    console.log(records_to_remove);
    p_delete_record(records_to_remove).then(msg => {
            return msg;
    }).catch( e => {
        console.error(`There was a problem deleting records: ${e}`)
        return common_utils.errorizeMessage(e);
    });
    await removeIDFiles(schema, table, hash_attribute, hashes_to_remove);
};

async function removeIDFiles(schema, table, hash_attribute, hash_id_paths) {
    if(common_utils.isEmptyOrZeroLength(schema) || schema === SYSTEM_SCHEMA_NAME) {
        harper_logger.info(`Invalid schema name.`);
        return;
    }
    if(common_utils.isEmptyOrZeroLength(table)) {
        harper_logger.info(`Invalid table name.`);
        return;
    }
    if(common_utils.isEmptyOrZeroLength(hash_attribute)) {
        harper_logger.info(`Invalid hash attribute.`);
        return;
    }
    if(common_utils.isEmptyOrZeroLength(hash_id_paths)) {
        return;
    }
    for(let i = 0; i<hash_id_paths.length; i++) {
        let curr_id_path = hash_id_paths[i];
        let files_in_dir = [];
        try {
            files_in_dir = await p_fs_readdir(curr_id_path);
        } catch(e) {
            harper_logger.error(`There was a problem reading dir ${curr_id_path}.  ${e}`);
            continue;
        }
        for(let file_num = 0; file_num < files_in_dir.length; file_num++) {
            try {
                harper_logger.trace(`trying to unlink file ${files_in_dir[file_num]}`);
                await p_fs_unlink(path.join(curr_id_path, files_in_dir[file_num]));
            } catch(e) {
                harper_logger.error(`There was a problem unlinking file ${files_in_dir[file_num]}.  ${e}`);
                continue;
            }
        }
        try {
            await p_fs_rmdir(curr_id_path);
        } catch(e) {
            harper_logger.error(`There was a problem removing directory ${curr_id_path}.  ${e}`);
            continue;
        }
    }
}

async function inspectHashAttributeDir(date_unix_ms, dir_path, hash_attribute, hash_attributes_to_remove) {
    let found_dirs = [];
    await getDirectoriesInPath(dir_path, found_dirs, date_unix_ms);
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
                let curr_file_time = convertUnixStringToMoment(files_in_dir[i]);
                if(!isParameterDateGreaterThanFileDate(latest_file_time, curr_file_time)) {
                    latest_file = undefined;
                    break;
                } else {
                    latest_file = files_in_dir[i];
                }
            }
        }
        if(!common_utils.isEmptyOrZeroLength(latest_file) && isParameterDateGreaterThanFileDate(date_unix_ms, latest_file)) {
            hash_attributes_to_remove.push(found_dirs[curr_dir]);
        }
    }
}

function convertUnixStringToMoment(date_val) {
    try {
        let parsed_time = moment(common_utils.stripFileExtension(date_val), MOMENT_UNIX_TIMESTAMP_FLAG);
        return parsed_time;
    } catch(e) {
        harper_logger.info("had problem parsing file time" + e);
        return null;
    }
}

function isParameterDateGreaterThanFileDate(parameter_date, file_name) {
    let parsed_time = convertUnixStringToMoment(file_name);
    if(parsed_time && parsed_time.isValid() && parsed_time.isBefore(parameter_date)) {
        return true;
    }
    return false;
}

/**
 * Return an array of directories in the path sent.  Will always return an array, even empty, when no files found.
 * @param dirPath - path to find directories for.
 * @param found_files - An object key,value map of file names and stats <file_name_key, fs_stats>.  This should be a "pure"
 * key/value object created via Object.create(null). We don't want object prototype keys so we can avoid any name collisions.
 * @returns {Array}
 */
async function getDirectoriesInPath(dirPath, found_files, date_unix_ms) {
    let list = undefined;
    try {
        list = await p_fs_readdir(dirPath);
    } catch (e) {
        harper_logger.error(e);
        return;
    }
    if(!list) { return; }
    let pending = list.length;

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
        let temp = date_unix_ms.valueOf();
        if (stats && stats.isDirectory() && stats.mtimeMs < date_unix_ms.valueOf()) {
            try {
                //found_files[file] = stats;
                found_files.push(file);
                await getDirectoriesInPath(file, found_files, date_unix_ms);
            } catch(e) {
                harper_logger.info(`Had trouble getting files for directory ${file}.`);
                return;
            }
        }
    }
    return;
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

            callback(null, SUCCESS_MESSAGE);
        });
    } catch(e){
        callback(e);
    }
};

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
};

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

    async.each(paths, (path, caller)=>{
        fs.unlink(path, (err)=>{
            if(err){
                if(err.code === ENOENT_ERROR_CODE){
                    return caller();
                }
                harper_logger.error(err);
                return caller(common_utils.errorizeMessage(err));
            }

            return caller();
        });
    }, (err)=>{
        if(err){
            return callback(common_utils.errorizeMessage(err));
        }

        return callback();
    });
};