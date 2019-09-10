'use strict';

const mkdirp = require('../../../../utility/fs/mkdirp');
const writeFile = require('../../../../utility/fs/writeFile');
const hdb_terms = require('../../../../utility/hdbTerms');

module.exports = processData;

/**
 * Wrapper function that orchestrates the record creation on disk
 * @param data_wrapper
 */
async function processData(data_wrapper) {
    try {
        await createFolders(data_wrapper.folders);
        await writeRawDataFiles(data_wrapper.raw_data);
    } catch(err) {
        throw err;
    }
}

/**
 * creates all of the folders necessary to hold the raw files and hard links
 * @param folders
 */
async function createFolders(folders) {
    try {
        await mkdirp(folders, {mode:  hdb_terms.HDB_FILE_PERMISSIONS});
    } catch (err) {
        throw err;
    }
}

/**
 * writes the raw data files to disk
 * @param data
 */
async function writeRawDataFiles(data) {
    try {
        await writeFile(data);
    } catch(err) {
        throw err;
    }
}
