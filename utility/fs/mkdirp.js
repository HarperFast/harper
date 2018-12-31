let fs_mkdirp = require('fs-extra').mkdirp;
const logger = require('../logging/harper_logger');

/**
 *
 * @param {Array.<string>} folders
 * @returns {Promise<void>}
 */
module.exports = async folders =>{
    await Promise.all(
        folders.map(async folder=>{
            try {
                await fs_mkdirp(folder);
            } catch(err){
                logger.error(err);
            }
        })
    );
};

