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
const winston = require('../utility/logging/winston_logger');
const harper_logger = require('../utility/logging/harper_logger');

hdb_properties.append(hdb_properties.get('settings_path'));
const slash_regex =  /\//g;
const base_path = common_utils.buildFolderPath(hdb_properties.get('HDB_ROOT'), "schema");
const HDB_HASH_FOLDER_NAME = '__hdb_hash';
const BLOB_FOLDER_NAME = 'blob';
const MAX_BYTES = '255';
const ENOENT_ERROR_CODE = 'ENOENT';
const SUCCESS_MESSAGE = 'records successfully deleted';

const hdb_path = path.join(hdb_properties.get('HDB_ROOT'), '/schema');

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
function deleteFilesBefore(date, schema, table, callback) {
    if(common_utils.isEmptyOrZeroLength(date)) {
        return callback("Invalid date.", null);
    }
    if(common_utils.isEmptyOrZeroLength(schema)) {
        return callback("Invalid schema.", null);
    }
    if(common_utils.isEmptyOrZeroLength(table)) {
        return callback("Invalid table.", null);
    }
    let parsed_date = moment(date, moment.ISO_8601);

    if(!parsed_date.isValid()) {
        return callback("Invalid date.");
    }

    let hash_dir_path = common_utils.buildFolderPath(hdb_path, schema, table, HDB_HASH_FOLDER_NAME);
    let deleted_file_count = 0;
    async.waterfall([
        doesDirectoryExist.bind(null, hash_dir_path),
        listDirectories.bind(null, hash_dir_path),
        getFiles,
        // This function is purposefully defined here as it's easier to read than a function that has 2 async.each calls.
        function inAllDirs(results, callback) {
            if(common_utils.isEmptyOrZeroLength(results)) {
                return callback(null);
            }
            async.forEachOf(results, function callRemoveOnDirs(found_in_path) {
                removeFiles(parsed_date, found_in_path.dir_path, found_in_path.files, function removeComplete(err, deleted) {
                    if(err) {
                        return callback(common_utils.errorizeMessage(err));
                    }
                    deleted_file_count += deleted;
                    return callback(null);
                });
            }, function forEachOfDone(err) {
               if(err) {
                   harper_logger.error(err);
                   return callback(err, null);
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
};

/**
 * Internal function used to verify a given directory path exists.
 * @param dir_path - directory path to stat
 * @param callback
 * @returns {*}
 */
function doesDirectoryExist(dir_path, callback) {
    if(common_utils.isEmptyOrZeroLength(dir_path)) {
        return callback(common_utils.errorizeMessage('not a valid directory path'), null);
    }
    try {
        fs.stat(dir_path, function statDir(err, stat) {
            if(err) {
                return callback(err, null);
            }
            if (stat && stat.isDirectory()) {
                // This callback is empty on purpose, we don't want to pass anything to the next function in a waterfall.
                return callback();
            } else {
                return callback(common_utils.errorizeMessage('not a valid directory path'), null);
            }
        });
    } catch (e) {
        return callback(e, null);
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
 * @param dir_path - The path to the directory containing the files listed in the files parameter.
 * @param files - An array of file names.
 * @param callback
 */
function removeFiles(date, dir_path, files, callback) {
    let filesRemoved = 0;
    if(common_utils.isEmptyOrZeroLength(date) || !date.isValid()) {
        return callback(common_utils.errorizeMessage('Invalid date'), filesRemoved);
    }
    if(common_utils.isEmptyOrZeroLength(dir_path)) {
        return callback(common_utils.errorizeMessage('Invalid directory path'), filesRemoved);
    }
    if(common_utils.isEmptyOrZeroLength(files)) {
        return callback(null, filesRemoved);
    }
    async.each(files, function getFilesInDirs(file, caller) {
        let fileRemovePath = path.join(dir_path, file);
        fs.stat(fileRemovePath, function statFile(err, stat) {
            if(err) {
                harper_logger.info(err);
                return caller();
            }
            if(stat.mtimeMs < date.valueOf()) {
                harper_logger.info(`removing file ${fileRemovePath}`)
                fs.unlink(fileRemovePath, function unlinkFile(err) {
                    if(err) {
                        harper_logger.error(`failed to remove file ${fileRemovePath}`);
                        caller(common_utils.errorizeMessage(err));
                    }
                    filesRemoved++;
                    caller();
                });
            } else {
                caller();
            }
        });
    }, function asyncEachDone(err) {
        if(err) {
            return callback(common_utils.errorizeMessage(err), null);
        }
        return callback(null, filesRemoved);
    });
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
function listDirectories(dirPath, callback) {
    let results = [];
    if(common_utils.isEmptyOrZeroLength(dirPath) || common_utils.isEmptyOrZeroLength(dirPath.trim())) {
        return callback(common_utils.errorizeMessage('Invalid directory path'), results);
    }
    fs.readdir(dirPath, function readDir(err, list) {
        if (err) {
            return callback(common_utils.errorizeMessage(err), results);
        }
        if(list.length === 0) {
            return callback(common_utils.errorizeMessage('No files found'), results);
        }

        async.each(list, function iterateFileList(found_file, caller) {
            try {
                found_file = path.resolve(dirPath, found_file);
            } catch(e) {
                console.error(e);
            }
            fs.stat(found_file, function statFiles(err, stat) {
                if(err) {
                    harper_logger.info(err);
                    return caller();
                }
                if (stat && stat.isDirectory()) {
                    results.push(found_file);
                }
                caller();
            });
        }, function eachError(err) {
            if(err) {
                harper_logger.info(err);
                return callback(err, null);
            }
            return callback(err, results);
        });
    });
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
};