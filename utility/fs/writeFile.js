"use strict";

const fs = require('fs-extra');
const logger = require('../logging/harper_logger');
const _ = require('lodash');
const path = require('path');
const terms = require('../hdbTerms');

const CHUNK_SIZE = 5000;

module.exports = writeFiles;

/**
 * If files length greater than CHUNK_SIZ, await work is called sequentially.
 * @param files
 * @returns {Promise<void>}
 */
async function writeFiles(files) {

    try {
        if (files.length < CHUNK_SIZE) {
            await work(files);
        } else {
            let chunks = _.chunk(files, CHUNK_SIZE);
            for (let chunk of chunks){
                await work(chunk);
            }
        }

    } catch(err) {
        throw err;
    }
}

/**
 * Writes files to the file system & if the file has a link also writes the link
 * @param files
 * @returns {Promise<void>}
 */
async function work(files){
    await Promise.all(
        files.map(async (file) => {
            try {
                await writeFile(file);
                await writeLink(file);
            } catch(e){
                logger.error(e);
            }
        })
    );

    files = null;
}

/**
 * writes the file, if the parent folder does not exist we catch the ENOENT exception, create the folder and write the file
 * @param file
 * @returns {Promise<void>}
 */
async function writeFile(file){
    try {
        await fs.writeFile(file.path, file.value);

    } catch(e){
        if(e.code === 'ENOENT'){
            await createMissingFolder(file.path);
            await writeFile(file);
        }else {
            logger.error(e);
        }

    }
}

/**
 * writes the link, if the parent folder does not exist we catch the ENOENT exception, create the folder and write the link
 * @param file
 * @returns {Promise<void>}
 */
async function writeLink(file){
    if (file.link_path) {
        try {
            await fs.link(file.path, file.link_path);
        } catch(e){
            if(e.code === 'ENOENT'){
                await createMissingFolder(file.path);
                await writeLink(file);
            } else {
                logger.error(e);
            }
        }
    }
}

/**
 * extracts the parent folder from the file path and creates the directory
 * @param file_path
 * @returns {Promise<void>}
 */
async function createMissingFolder(file_path){
    try {
        let folder_path = path.dirname(file_path);
        await fs.mkdirp(folder_path, {mode: terms.HDB_FILE_PERMISSIONS});
    } catch(err) {
        logger.error(`Failed to create the directory.`);
        throw err;
    }
}
