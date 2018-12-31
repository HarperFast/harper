const fs_link = require('fs-extra').link;

/**
 * takes an
 * @param {Array.<./LinkObject>} files
 * @returns {Promise<void>}
 */
module.exports = async links => {
    await Promise.all(
        links.map(async link => {
            try {
                await fs_link(link.existing_path, link.new_path);
            } catch(e){
                if (e.code !== 'EEXIST') {
                    throw e;
                }
            }
        })
    );
};