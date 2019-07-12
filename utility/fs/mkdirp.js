"use strict";

let fs_mkdirp = require('fs-extra').mkdirp;
const logger = require('../logging/harper_logger');
const terms = require('../hdbTerms');
const _ = require('lodash');

const CHUNK_SIZE = 5000;

module.exports = makeDirectories;

/**
 * If folders length greater than CHUNK_SIZ, await writeDirectories is called sequentially.
 * @param folders
 * @param permissions_object
 * @returns {Promise<void>}
 */

async function makeDirectories(folders, permissions_object) {

    try {
        if (folders.length < CHUNK_SIZE) {
            await writeDirectories(folders, permissions_object);
        } else {
            let chunks = _.chunk(folders, CHUNK_SIZE);

            for (let chunk of chunks) {
                await writeDirectories(chunk, permissions_object);
            }
        }
    } catch(err) {
    throw err;
    }
}

/**
 * creates folders
 * @param {Array.<string>} folders
 * @param permissions_object - permissions to assign the directories in the form matching fs, {mode: 0o777}
 * @returns {Promise<void>}
 */
async function writeDirectories(folders, permissions_object) {
    await Promise.all(
        folders.map(async (folder) => {
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
