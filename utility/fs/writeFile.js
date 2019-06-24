"use strict";

const fs_write_file = require('fs-extra').writeFile;
const fs_link= require('fs-extra').link;
const logger = require('../logging/harper_logger');
const _ = require('lodash');
const CHUNK_SIZE = 10000;
module.exports = writeFiles;

/**
 * writes files to the file system & if the file has a link also writes the link
 * @param {Array.<./FileObject>} files
 * @returns {Promise<void>}
 */
async function writeFiles(files) {
    try {
        if (files.length < CHUNK_SIZE) {
            await work(files);
        } else {
            let chunks = _.chunk(files, CHUNK_SIZE);

            for(let chunk of chunks){
                await work(chunk);
            }
        }
    } catch(err) {
        throw err;
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