'use strict';

const log = require('../../../../utility/logging/harper_logger');
const hdb_util = require('../../../../utility/common_utils');
const terms = require('../../../../utility/hdbTerms');
const fs = require('fs-extra');

module.exports = moveFolderToTrash;

/**
 * Move the specified folder from path to the trash path folder.  If the trash folder does not exist, it will be created.
 *
 * @param path
 * @param trash_path
 * @returns {Promise<boolean>}
 */
async function moveFolderToTrash(origin_path, trash_path) {
    if(hdb_util.isEmptyOrZeroLength(origin_path) || hdb_util.isEmptyOrZeroLength(trash_path)) {
        return false;
    }

    try {
        await fs.mkdirp(trash_path, {mode: terms.HDB_FILE_PERMISSIONS});
    } catch(err) {
        log.error(`Failed to create the trash directory.`);
        throw err;
    }

    try {
        await fs.move(origin_path,trash_path, {overwrite: true});
    } catch(err) {
        log.error(`Got an error moving path ${origin_path} to trash path: ${trash_path}`);
        throw err;
    }
    return true;
}
