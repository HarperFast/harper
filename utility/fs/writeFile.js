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
            let x = 0;

            for(let chunk of chunks){
                x++;
                await work(chunk);
                const used = process.memoryUsage().heapUsed / 1024 / 1024;
                console.log(`writeFile call: ${x}, current memory usage: ${Math.round(used * 100) / 100} MB`);
            }
        }
    } catch(err) {
        throw err;
    }
}

// async function writeFiles(files) {
//     let chunk;
//     let x = 0;
//     let chunk_start = 0;
//     let chunk_finish;
//     do {
//         chunk = [];
//         chunk_finish = files.length > chunk_start + CHUNK_SIZE ? chunk_start + CHUNK_SIZE: files.length;
//
//         chunk = files.slice(chunk_start, chunk_finish);
//
//         await work(chunk);
//
//         chunk_start = chunk_finish;
//
//         x++;
//         const used = process.memoryUsage().heapUsed / 1024 / 1024;
//         console.log(`writeFile call: ${x}, current memory usage: ${Math.round(used * 100) / 100} MB`);
//     } while (files.length > chunk_finish);
// }

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