const fs_write_file = require('fs-extra').writeFile;

/**
 * takes an
 * @param {Array.<./FileObject>} files
 * @returns {Promise<void>}
 */
module.exports = async files => {
    await Promise.all(
        files.map(async file => {
            await fs_write_file(file.path, file.value);
        })
    );
};