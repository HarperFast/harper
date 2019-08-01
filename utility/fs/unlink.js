"use strict";

const fs_unlink = require('fs-extra').unlink;
const fs_rmdir = require('fs-extra').rmdir;
const logger = require('../logging/harper_logger');
const path = require('path');

module.exports = unlink;

/**
 * removes files from the file system
 * @param {Array.<string>} paths
 * @returns {Promise<void>}
 */
async function unlink(paths) {
    await Promise.all(
        paths.map(async file_path => {
            try {
                await fs_unlink(file_path);
            } catch(e){
                if(e.code !== 'ENOENT'){
                    logger.error(e);
                }
            }

            try {
                //attempt to remove the folder that contains the file
                let folder = path.dirname(file_path);
                if(folder.indexOf('__hdb_hash') < 0) {
                    await fs_rmdir(folder);
                }
            }catch(e){
                if(e.code !== 'ENOTEMPTY'){
                    logger.error(e);
                }
                console.log(e);
            }
        })
    );
}