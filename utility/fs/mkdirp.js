"use strict";

let fs_mkdirp = require('fs-extra').mkdirp;
const logger = require('../logging/harper_logger');
const terms = require('../hdbTerms');
const _ = require('lodash');

const CHUNK_SIZE = 5000;

module.exports = makeDirectories;

async function makeDirectories(folders, permissions_object) {

    let maxBefore = 0;
    let minBefore = 100000;
    let maxAfter = 0;
    let minAfter = 100000;

    try {
        if (folders.length < CHUNK_SIZE) {
            await writeDirectories(folders, permissions_object);
        } else {
            //console.log(`writeDirs - before chunk: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);
            let chunks = _.chunk(folders, CHUNK_SIZE);
            //console.log(`writeDirs - after chunk: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);

            for (let chunk of chunks) {

                let valBefore = Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;
                if (valBefore > maxBefore) {
                    maxBefore = valBefore;
                } else if (valBefore < minBefore) {
                    minBefore = valBefore;
                }

                //console.log(`makeDirs start: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);
                await writeDirectories(chunk, permissions_object);
                //console.log(`makeDirs finish: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);

                let valAfter = Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;
                if (valAfter > maxAfter) {
                    maxAfter = valAfter;
                } else if (valBefore < minAfter) {
                    minAfter = valAfter;
                }
            }
            console.log(`writeDir max before: ${maxBefore} MB`);
            console.log(`writeDir min before: ${minBefore} MB`);
            console.log(`writeDir max after: ${maxAfter} MB`);
            console.log(`writeDir min after: ${minAfter} MB`);
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
        folders.map(async (folder, index) => {
            try {
                if(!permissions_object || !permissions_object.mode) {
                    permissions_object['mode'] = terms.HDB_FILE_PERMISSIONS;
                }
                await fs_mkdirp(folder, permissions_object);
            } catch (err) {
                logger.error(err);
            }
            // finally {
            //     folder[index] = null;
            // }
        })
    );
    folders = null;
}

