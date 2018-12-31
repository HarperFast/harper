let fs_mkdirp = require('fs-extra').mkdirp;

/**
 *
 * @param {Array.<string>} folders
 * @returns {Promise<void>}
 */
module.exports = async folders =>{
    await Promise.all(
        folders.map(async folder=>{
            await fs_mkdirp(folder);
        })
    );
};

