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
const base_path = common_utils.buildFolderPath(hdb_properties.get('HDB_ROOT'), "schema");
const HDB_HASH_FOLDER_NAME = '__hdb_hash';
const BLOB_FOLDER_NAME = 'blob';
const MAX_BYTES = '255';
const ENOENT_ERROR_CODE = 'ENOENT';
const SUCCESS_MESSAGE = 'records successfully deleted';
const HDB_FILE_SUFFIX = '.hdb';

const hdb_path = path.join(hdb_properties.get('HDB_ROOT'), '/schema');

// Promisified functions
const p_fs_stat = promisify(fs.stat);
const p_fs_readdir = promisify(fs.readdir);
const p_fs_unlink = promisify(fs.unlink);

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
 * @param date - the date where all file before this time will be deleted from the disk.  The string must match ISO-8601 format.
 * @param schema - The schema to remove files from
 * @param table - The table to remove files from
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

    let hash_dir_path = common_utils.buildFolderPath(hdb_path, schema, table, HDB_HASH_FOLDER_NAME);
    let deleted_file_count = 0;
    /*
    async.waterfall([
        doesDirectoryExist.bind(null, hash_dir_path),
        getFilesInDirectories.bind(null, hash_dir_path),
        getFiles,
        // This function is purposefully defined here as it's easier to read than a function that has 2 async.each calls.
        function inAllDirs(results, callback) {
            if(common_utils.isEmptyOrZeroLength(results)) {
                return callback(null);
            }
            async.forEachOf(results, function callRemoveOnDirs(found_in_path, directory, caller) {
                removeFiles(parsed_date, found_in_path.files, function removeComplete(err, deleted) {
                    if(err) {
                        return callback(common_utils.errorizeMessage(err));
                    }
                    deleted_file_count += deleted;
                    caller();
                });
            }, function forEachOfDone(err) {
               if(err) {
                   harper_logger.error(err);
                   return callback(err,null);
               }
               return callback(null);
            });
        }
    ], function deleteFilesWaterfallDone(err, data) {
        if (err) {
            return callback(err);
        }
        let message = `Deleted ${deleted_file_count} files`;
        harper_logger.error(message);
        return callback(null, message);
    });
    */
    let message = `Deleted ${deleted_file_count} files`;
    return callback(null, message);
};

async function walkPath(dir_path) {
    const doesExist = await doesDirectoryExist(dir_path);
    if(!doesExist) {
        let message = "Invalid Directory Path.";
        harper_logger.info(message);
        return common_utils.errorizeMessage(message);
    }

    let found_files = Object.create(null);
    await getFilesInDirectories(dir_path, found_files);
    if(common_utils.isEmptyOrZeroLength(found_files)) {
        let message = "No files found";
        harper_logger.info(message);
        return message;
    }
}

/**
 * Internal function used to verify a given directory path exists.
 * @param dir_path - directory path to stat
 * @param callback
 * @returns {*}
 */
async function doesDirectoryExist(dir_path) {
    if(common_utils.isEmptyOrZeroLength(dir_path)) {
        harper_logger.info('not a valid directory path');
        return false;
    }
    try {
        let stats = await p_fs_stat(dir_path);
        if (stats && stats.isDirectory()) {
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
 * Returns a map of all files found in the directories array passed as a parameter.
 * @param results - An array of full directory paths
 * @param callback
 */
function getFiles(results, callback) {
    // This is a "pure" key/value object. We don't want object prototypes to avoid any name collisions.
    let foundFiles = Object.create(null);
    if(common_utils.isEmptyOrZeroLength(results)) {
        return callback(null, foundFiles);
    }
    async.each(results, function getFilesInDirs(file, caller) {
        if(!common_utils.isEmptyOrZeroLength(file)) {
            getFilesInDirectory(file, function(err, files) {
                if(err) {
                    harper_logger.info(`No files found in path ${file}`);
                    return caller();
                }
                if(!common_utils.isEmptyOrZeroLength(files)) {
                    foundFiles[file] = Object.create(null);
                    foundFiles[file].dir_path = file;
                    foundFiles[file].files = [];
                    foundFiles[file].files.push(...files);
                }
                return caller();
            });
        }
    }, function asyncEachDone(err) {
        if(err) {
            return callback(common_utils.errorizeMessage(err), null);
        }
        return callback(null, foundFiles);
    });
};

/**
 * Removes all files which had a last modified date less than the date parameter.
 * @param date - A date passed as a moment.js date object.
 * @param files - An object key,value map of file names and stats <file_name_key, fs_stats>.  This should be a "pure"
 * key/value object created via Object.create(null). We don't want object prototype keys so we can avoid any name collisions.
 */
async function removeFiles(date, files) {
    let filesRemoved = 0;
    if(common_utils.isEmptyOrZeroLength(date) || !date.isValid()) {
        return filesRemoved;
    }
    if(common_utils.isEmptyOrZeroLength(files)) {
        return filesRemoved;
    }

    for(let file in files) {
        let stats = files[file];
        if (stats.mtimeMs < date.valueOf()) {
            harper_logger.info(`removing file ${file}`);
            try {
                await p_fs_unlink(file);
                filesRemoved++;
            } catch (e) {
                harper_logger.error(e);
            }
        }
    }
    return filesRemoved;
};

/**
 * Returns an array containing the file names of all files in a directory path.
 * @param dirPath - Path to find file names for.
 * @param callback
 */
function getFilesInDirectory(dirPath, callback) {
    if(common_utils.isEmptyOrZeroLength(dirPath) || common_utils.isEmptyOrZeroLength(dirPath.trim())) {
        return callback(common_utils.errorizeMessage('Invalid directory path'), []);
    }

    fs.readdir(dirPath, function readDir(err, list) {
        if (err) {
            return callback(common_utils.errorizeMessage(err), []);
        }
        return callback(null, list);
    });
};

/**
 * Return an array or directories in the path sent.  Will always return an array, even empty, when no files found.
 * @param dirPath - path to find directories for.
 * @param callback
 * @returns {Array}
 */
async function getFilesInDirectories(dirPath, found_files) {
    //let results = Object.create(null);
    let list = undefined;
    try {
        list = await p_fs_readdir(dirPath);
    } catch (e) {
        harper_logger.error(e);
        return;
    }
    let pending = list.length;
    if(!pending) { return; }

    for(let found in list) {
        let file = path.resolve(dirPath, list[found]);
        let stats = await p_fs_stat(file);
        if (stats && stats.isDirectory()) {
            //results.push(file);
            let res = await getFilesInDirectories(file, found_files);
            //results = results.concat(res);
        } else {
            //results.push(file);
            found_files[file] = stats;
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
    let table_path = common_utils.buildFolderPath(base_path, schema, table);

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