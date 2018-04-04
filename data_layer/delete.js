const validate = require('validate.js');
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

hdb_properties.append(hdb_properties.get('settings_path'));
const slash_regex =  /\//g;
const base_path = common_utils.buildFolderPath(hdb_properties.get('HDB_ROOT'), "schema");
const HDB_HASH_FOLDER_NAME = '__hdb_hash';
const BLOB_FOLDER_NAME = 'blob';
const MAX_BYTES = '255';
const ENOENT_ERROR_CODE = 'ENOENT';
const SUCCESS_MESSAGE = 'records successfully deleted';
hdb_properties.append(hdb_properties.get('settings_path'));
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
 * @param date - the date where all file before this time will be deleted from the disk.
 * @param schema - The schema to remove files from
 * @param table - The table to remove files from
 * @param callback
 */
function deleteFilesBefore(date, schema, table, callback) {
    if(common_utils.isEmptyOrZeroLength(date)) {
        callback("Invalid date.", null);
    }
    if(common_utils.isEmptyOrZeroLength(schema)) {
        callback("Invalid schema.", null);
    }
    if(common_utils.isEmptyOrZeroLength(table)) {
        callback("Invalid table.", null);
    }
    let parsed = moment(date, moment.ISO_8601);

    if(!parsed.isValid()) {
        return callback("Invalid date");
    }

    let dir_path = common_utils.buildFolderPath(hdb_path, schema, table, HDB_HASH_FOLDER_NAME);

    async.waterfall([
        listDirectories.bind(null, dir_path),
        getFiles,
        removeFiles.bind(null, parsed)
    ], function(err, data) {
        if (err) {
            return callback(err);
        }
        return callback(null, data);
    });
    /*
    listDirectories(file_path, function getDirs(err, results) {
        if(err) {
            return callback(err);
        }
        hdbDirectories = results;
        results.forEach(function getFilesInDirectores(dir) {
            if(err) {
                return callback(common_utils.errorizeMessage(err));
            }
            getFilesInDirectory(path.join(dir), function getFiles(err, files) {
                files.forEach(function inspectFiles(file) {
                    let fileRemovePath = path.join(dir,file);
                    fs.stat(fileRemovePath, function statFile(err, stat) {
                        if(stat.mtimeMs < parsed.valueOf()) {
                            harper_logger.info(`removing file ${fileRemovePath}`)
                            fs.unlink(fileRemovePath, function unlinkFile(err) {
                               if(err) {
                                   harper_logger.error(`failed to remove file ${fileRemovePath}`);
                               }
                               callback(null, null);
                            });
                        }
                    });
                });
            });
        });
    }); */
}

/**
 * Returns all files found in the directories array passed as a parameter.
 * @param results - An array of directory paths
 * @param callback
 */
function getFiles(results, callback) {
    let foundFiles = [];
    async.each(results, function getFilesInDirs(file) {
        getFilesInDirectory(file, function(files, caller) {
            if(!common_utils.isEmpty(files)) {
                foundFiles.push(...files);
            }
            caller(null, null);
        });
    }, function done(err) {
        if(err) {
            return callback(common_utils.errorizeMessage(err), null);
        }
        return callback(null, foundFiles);
    });
}

/**
 * Removes all files which had a last modified date less than the date parameter.
 * @param files - An array of file paths
 * @param date - A date passed as a moment.js object.
 * @param callback
 */
function removeFiles(files, date, callback) {
    let filesRemoved = [];
    async.each(files, function getFilesInDirs(file) {
        let fileRemovePath = file;
        fs.stat(file, function statFile(err, stat) {
            if(stat.mtimeMs < parsed.valueOf()) {
                filesRemoved.push(fileRemovePath);
                harper_logger.info(`removing file ${fileRemovePath}`)
                fs.unlink(fileRemovePath, function unlinkFile(err) {
                    if(err) {
                        harper_logger.error(`failed to remove file ${fileRemovePath}`);
                    }
                });
            }
        });
    }, function done(err) {
        if(err) {
            return callback(common_utils.errorizeMessage(err), null);
        }
        return callback(null, filesRemoved);
    });
}

/**
 * Returns an array containing all files in a directory path.
 * @param dirPath - Path to find directories for.
 * @param callback
 */
function getFilesInDirectory(dirPath, callback) {
    if(common_utils.isEmptyOrZeroLength(dirPath) || common_utils.isEmptyOrZeroLength(dirPath.trim())) {
        return callback(new Error('Invalid directory path'), results);
    }

    fs.readdir(dirPath, function readDir(err, list) {
        if (err) {
            return callback(common_utils.errorizeMessage(err), null);
        }
        return callback(null, list);
    });
}

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
        let pending = list.length;
        if (!pending){ return callback(null, results);}
        list.forEach(function iterateFileList(file) {
            try {
                file = path.resolve(dirPath, file);
            } catch(e) {
                console.error(e);
            }
            fs.stat(file, function statFiles(err, stat) {
                if (stat && stat.isDirectory()) {
                    results.push(file);
                    if (!--pending) {
                        callback(null, results);
                    }
                } else {
                    if (!--pending) {
                        callback(null, results);
                    }
                }
            });
        });
    });
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