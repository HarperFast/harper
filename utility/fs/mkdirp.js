"use strict";

let fs_mkdirp = require('fs-extra').mkdirp;
const logger = require('../logging/harper_logger');
const terms = require('../hdbTerms');

module.exports = makeDirectories;

/**
 * creates folders
 * @param {Array.<string>} folders
 * @param permissions_object - permissions to assign the directories in the form matching fs, {mode: 0o777}
 * @returns {Promise<void>}
 */
async function makeDirectories(folders, permissions_object) {
    await Promise.all(
        folders.map(async folder => {
            try {
                if(!permissions_object || !permissions_object.mode) {
                    permissions_object['mode'] = terms.HDB_FILE_PERMISSIONS;
                }
                await fs_mkdirp(folder, permissions_object);
            } catch (err) {
                logger.error(err);
            }
        })
    );
    folders = null;
}

