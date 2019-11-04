'use strict';

const buildFolderPath = require('../fsUtility/buildFolderPath');
const getBasePath = require('../fsUtility/getBasePath');
const fsDeleteRecords = require('../fsMethods/fsDeleteRecords');
const bulkDeleteValidator = require('../../../../validation/bulkDeleteValidator');
const log = require('../../../../utility/logging/harper_logger');
const hdb_utils = require('../../../../utility/common_utils');
const terms = require('../../../../utility/hdbTerms');
const moment = require('moment');
const fs = require('graceful-fs');
const util = require('util');
const path = require('path');

const p_fs_stat = util.promisify(fs.stat);
const p_fs_unlink = util.promisify(fs.unlink);
const p_fs_readdir = util.promisify(fs.readdir);
const p_fs_rmdir = util.promisify(fs.rmdir);

const MOMENT_UNIX_TIMESTAMP_FLAG = 'x';

module.exports = deleteRecordsBefore;

async function deleteRecordsBefore(delete_obj) {
    let dir_path = buildFolderPath(getBasePath(), delete_obj.schema, delete_obj.table);
    let parsed_date = moment(delete_obj.date, moment.ISO_8601);

    try {
        await deleteFilesInPath(delete_obj.schema, delete_obj.table, dir_path, parsed_date);
    } catch(err) {
        throw new Error(`There was an error deleting files by date: ${err}`);
    }
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
    if(hdb_utils.isEmptyOrZeroLength(dir_path)) {
        log.error(`directory path ${dir_path} is invalid.`);
        return;
    }

    if(!date || !moment.isMoment(date) || !date.isValid()) {
        log.error(`date ${date} is invalid.`);
        return;
    }

    if(hdb_utils.isEmptyOrZeroLength(schema) || schema === terms.SYSTEM_SCHEMA_NAME) {
        log.error(`Schema ${schema} is invalid.`);
        return;
    }

    if(hdb_utils.isEmptyOrZeroLength(table)) {
        log.error(`Table ${table} is invalid.`);
        return;
    }

    let hash_attribute = undefined;
    try {
        hash_attribute = global.hdb_schema[schema][table].hash_attribute;
    } catch (e) {
        log.error(`Schema ${schema} and table ${table} attributes were not found.`);
        return;
    }

    let doesExist = await doesDirectoryExist(dir_path).catch(e => {
        log.info(`There was a problem checking directory ${dir_path}`);
    });

    if (!doesExist) {
        let message = "Invalid Directory Path.";
        log.info(message);
        return hdb_utils.errorizeMessage(message);
    }

    let found_files = [];
    await inspectHashAttributeDir(date, path.join(dir_path, hash_attribute), found_files).catch(e => {
        log.info(`There was a problem getting attributes for table directory ${dir_path}`);
    });

    if (hdb_utils.isEmptyOrZeroLength(found_files)) {
        let message = "No files found";
        log.info(message);
        return message;
    }

    await removeFiles(schema, table, hash_attribute, found_files).catch( e => {
        log.info(`There was a problem removing files for Schema ${schema} and table ${table}`);
    });
}

/**
 * Internal function used to verify a given directory path exists.
 * @param dir_path - directory path to stat
 * @returns {*}
 */
async function doesDirectoryExist(dir_path) {
    if(hdb_utils.isEmptyOrZeroLength(dir_path)) {
        log.info('not a valid directory path');
        return false;
    }
    try {
        log.trace(`Checking directory ${dir_path}`);
        let stats = await p_fs_stat(dir_path);

        return stats && stats.isDirectory();
    } catch (e) {
        log.info(e);
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

    let validation = bulkDeleteValidator(records_to_remove);
    if (validation) {
        throw validation;
    }

    try {
        await fsDeleteRecords(records_to_remove);
        if (schema !== terms.SYSTEM_SCHEMA_NAME) {
            let delete_msg = hdb_utils.getClusterMessage(terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
            delete_msg.transaction = records_to_remove;
            hdb_utils.sendTransactionToSocketCluster(`${schema}:${table}`, delete_msg);
        }

        await removeIDFiles(schema, table, hash_attribute, ids_to_remove);
    } catch (e) {
        log.info(`There was a problem deleting records: ${e}`);
        return hdb_utils.errorizeMessage(e);
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
    if(hdb_utils.isEmptyOrZeroLength(schema) || schema === terms.SYSTEM_SCHEMA_NAME) {
        log.info(`Invalid schema name.`);
        return;
    }
    if(hdb_utils.isEmptyOrZeroLength(table)) {
        log.info(`Invalid table name.`);
        return;
    }
    if(hdb_utils.isEmptyOrZeroLength(hash_ids)) {
        return;
    }
    for(let i = 0; i<hash_ids.length; i++) {
        let curr_id_path = undefined;
        let files_in_dir = [];
        try {
            curr_id_path = path.join(getBasePath(), schema, table, hash_attribute, hash_ids[i]);
            files_in_dir = await p_fs_readdir(curr_id_path);
        } catch(e) {
            log.error(`There was a problem reading dir ${curr_id_path}.  ${e}`);
            continue;
        }
        if(hdb_utils.isEmptyOrZeroLength(files_in_dir)) {
            continue;
        }

        for(let file_num = 0; file_num < files_in_dir.length; file_num++) {
            try {
                log.trace(`trying to unlink file ${files_in_dir[file_num]}`);
                await p_fs_unlink(path.join(curr_id_path, files_in_dir[file_num]));
            } catch(e) {
                log.error(`There was a problem unlinking file ${files_in_dir[file_num]}.  ${e}`);
            }
        }

        try {
            await p_fs_rmdir(curr_id_path);
        } catch(e) {
            log.error(`There was a problem removing directory ${curr_id_path}.  ${e}`);
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
            log.info(`An invalid date ${date_unix_ms} was passed `);
            return;
        }
    } catch (e) {
        log.error(e);
    }

    await getDirectoriesInPath(dir_path, found_dirs, date_unix_ms).catch(e => {
        log.info(`There was a problem inspecting the hash attribute dir ${dir_path}`);
    });

    if(!hash_attributes_to_remove) {
        log.info(`An invalid array was passed.`);
        return;
    }

    if(hdb_utils.isEmptyOrZeroLength(found_dirs)) {
        log.trace(`No hash directories were found to remove.`);
        return;
    }

    for(let curr_dir in found_dirs) {
        let files_in_dir = await p_fs_readdir(found_dirs[curr_dir]);
        if(hdb_utils.isEmptyOrZeroLength(files_in_dir)) {
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

        if(!hdb_utils.isEmptyOrZeroLength(latest_file) && isFileTimeBeforeParameterTime(date_unix_ms, latest_file)) {
            // The ID of the record should be the last /<TEXT> part of the path.  Pull the ID and remove the file.
            let dir_path = (found_dirs[curr_dir]);
            let id = dir_path.substring(dir_path.lastIndexOf('/')+1, dir_path.length);
            hash_attributes_to_remove.push(id);
        }
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
        log.info(`invalid date passed as parameter`);
        return false;
    }

    if(hdb_utils.isEmptyOrZeroLength(file_name)) {
        log.info(`invalid file name passed as parameter`);
        return false;
    }

    let parsed_time = convertUnixStringToMoment(file_name);
    return ( (parsed_time && parsed_time.isValid()) && parsed_time.isBefore(parameter_date));
}

/**
 * Converts strings of unix time stamps to a moment object.
 * @param date_val - A string with a unix ms time stamp as the value.
 * @returns {*} - A moment object.
 */
function convertUnixStringToMoment(date_val) {
    try {
        return moment(hdb_utils.stripFileExtension(date_val), MOMENT_UNIX_TIMESTAMP_FLAG);
    } catch(e) {
        log.info("had problem parsing file time" + e);
        return null;
    }
}

/**
 * fills in the found_dirs parameter with found directories.
 * @param dirPath - path to find directories for.
 * @param found_dirs - An array of directory paths.
 * @param date_unix_ms - The date to compare files found in dirPath.
 */
async function getDirectoriesInPath(dirPath, found_dirs, date_unix_ms) {
    if(!(date_unix_ms) || !moment(date_unix_ms).isValid()) {
        log.info(`An invalid date ${date_unix_ms} was passed `);
        return;
    }

    let list = undefined;
    try {
        list = await p_fs_readdir(dirPath);
    } catch (e) {
        log.info(`Specified Directory path ${dirPath} does not exist.`);
        return;
    }

    if(!list) { return; }

    for(let found in list) {
        if(list[found] === terms.HASH_FOLDER_NAME) {
            continue;
        }

        let file = path.resolve(dirPath, list[found]);
        let stats = undefined;

        try {
            stats = await p_fs_stat(file);
        } catch(e) {
            log.info(`Had trouble getting stats for file ${file}.`);
            return;
        }

        if (stats && stats.isDirectory() && stats.mtimeMs < date_unix_ms.valueOf()) {
            try {
                found_dirs.push(file);
                await getDirectoriesInPath(file, found_dirs, date_unix_ms);
            } catch(e) {
                log.info(`Had trouble getting files for directory ${file}.`);
                return;
            }
        }
    }
}
