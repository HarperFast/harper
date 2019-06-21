"use strict";

const fs_write_file = require('fs-extra').writeFile;
const fs_link= require('fs-extra').link;
const logger = require('../logging/harper_logger');
const _ = require('lodash');

module.exports = writeFiles;

/**
 * writes files to the file system & if the file has a link also writes the link
 * @param {Array.<./FileObject>} files
 * @returns {Promise<void>}
 */
async function writeFiles(files) {

    // TODO: add if statement here to check file size, if under 10000 dont chunk
    let chunks = _.chunk(files, 10000);

    for(let chunk of chunks){
        await work(chunk);
    }
}

async function work(files){
    await Promise.all(
        files.map(async file => {
            try {
                await fs_write_file(file.path, file.value);

                if (file.link_path) {
                    await fs_link(file.path, file.link_path);
                }
            } catch(e){
                logger.error(e);
            }
        })
    );

    files = null;
}