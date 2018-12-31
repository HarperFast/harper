const fs_unlink = require('fs-extra').unlink;
const logger = require('../logging/harper_logger');

/**
 * takes an
 * @param {Array.<string>} paths
 * @returns {Promise<void>}
 */
module.exports = async paths => {
    await Promise.all(
        paths.map(async path => {
            try {
                await fs_unlink(path);
            } catch(e){
                if(e.code !== 'ENOENT'){
                    logger.error(err);
                }
            }
        })
    );
};