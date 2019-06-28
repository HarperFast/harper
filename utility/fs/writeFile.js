"use strict";

const fs = require('fs-extra');
const fs_write_file = require('fs-extra').writeFile;
const fs_link= require('fs-extra').link;
const logger = require('../logging/harper_logger');
const _ = require('lodash');

const CHUNK_SIZE = 5000;

module.exports = writeFiles;

/**
 * writes files to the file system & if the file has a link also writes the link
 * @param {Array.<./FileObject>} files
 * @returns {Promise<void>}
 */
async function writeFiles(files) {

    let maxBefore = 0;
    let minBefore = 100000;
    let maxAfter = 0;
    let minAfter = 100000;

    try {
        if (files.length < CHUNK_SIZE) {
            await work(files);
        } else {
            //console.log(`writeFiles - before chunk: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);
            let chunks = _.chunk(files, CHUNK_SIZE);
            //console.log(`writeFiles - after chunk: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);

            for (let chunk of chunks){
                let valBefore = Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;
                if (valBefore > maxBefore) {
                    maxBefore = valBefore;
                } else if (valBefore < minBefore) {
                    minBefore = valBefore;
                }

                console.log(`writeFile work start: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);
                await work(chunk);
                console.log(`writeFile work finish: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);

                let valAfter = Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;
                if (valAfter > maxAfter) {
                    maxAfter = valAfter;
                } else if (valBefore < minAfter) {
                    minAfter = valAfter;
                }
            }
            // console.log(`writeFile max before: ${maxBefore} MB`);
            // console.log(`writeFile min before: ${minBefore} MB`);
            // console.log(`writeFile max after: ${maxAfter} MB`);
            // console.log(`writeFile min after: ${minAfter} MB`);
        }

    } catch(err) {
        throw err;
    }
}

async function work(files){
    await Promise.all(
        files.map(async (file) => {
            try {
                //console.log(`fs_write_file start: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);
                await fs_write_file(file.path, file.value);
                //console.log(`fs_write_file finish: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);

                if (file.link_path) {
                    //console.log(`fs_link start: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);
                    await fs_link(file.path, file.link_path);
                    //console.log(`fs_link finish: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);
                }
            } catch(e){
                logger.error(e);
            }
            finally {
                files.shift();
            }
        })
    );

    files = null;
}

function workCB(files) {
    return new Promise((resolve, reject) => {

        let x = 0;
        let files_length = files.length;
        for (let i = 0; i < files.length; i++) {
            //console.log(`fs_write_file start ${i}: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);
            fs.writeFile(files[i].path, files[i].value, (err) => {
                //console.log(`fs_write_file finish ${i}: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);
                if (err) {
                    reject(err);
                }

                if (files[i].link_path) {
                    //console.log(`fs_link start ${i}: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);
                    fs.link(files[i].path, files[i].link_path, (err) => {
                        if (err) {
                            reject(err);
                        }

                        //console.log(`fs_link start ${i}: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);
                    });

                }

                x++;

                if (x === files.length) {
                    resolve();
                }
            });
        }
    });
}