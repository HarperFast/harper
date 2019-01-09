const fs_access = require('fs-extra').access;
const F_OK = require('fs-extra').constants.F_OK;
const {promisify} = require('util');
const p_fs_access = promisify(fs_access);

module.exports = async file_path => {
    try {
        await p_fs_access(file_path, F_OK);
        return true;
    } catch (e) {
        return false;
    }
};