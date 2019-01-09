"use strict";

const fs_write_file = require('fs-extra').writeFile;
const fs_link= require('fs-extra').link;

/**
 * writes files to the file system
 * @param {Array.<./FileObject>} files
 * @returns {Promise<void>}
 */
module.exports = async files => {
    await Promise.all(
        files.map(async file => {
            await fs_write_file(file.path, file.value);
        })
    );

    await Promise.all(
        files.map(async file => {
            if(file.link_path) {
                await fs_link(file.path, file.link_path);
            }
        })
    );
    files = null;
};