"use strict";

let fs_mkdirp = require('fs-extra').mkdirp;
const logger = require('../logging/harper_logger');


module.exports = makeDirectories;

/**
 * creates folders
 * @param {Array.<string>} folders
 * @returns {Promise<void>}
 */
async function makeDirectories(folders) {
    await Promise.all(
        folders.map(async folder => {
            try {
                await fs_mkdirp(folder);
            } catch (err) {
                logger.error(err);
            }
        })
    );
    folders = null;
}

