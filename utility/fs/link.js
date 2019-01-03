const fs_link = require('fs-extra').link;

/**
 * takes an
 * @param {Array.<./FileObject>} files
 * @returns {Promise<void>}
 */
module.exports = async links => {
    await Promise.all(
        links.map(async link => {
            try {
                if(link.link_path) {
                    await fs_link(link.path, link.link_path);
                }
            } catch(e){
                if (e.code !== 'EEXIST') {
                    throw e;
                }
            }
        })
    );

    links = null;
};