const fs_access = require('fs-extra').access;
const {promisify} = require('util');
const p_fs_access = promisify(fs_access);
const hdb_terms = require('../hdbTerms');
const HDB_PATH_KEY = hdb_terms.INSERT_MODULE_ENUM.HDB_PATH_KEY;

module.exports = async (records) => {

    await Promise.all(
        records.map(async record => {
            if(record[HDB_PATH_KEY]) {
                try {
                    await p_fs_access(record[HDB_PATH_KEY]);
                    record[HDB_PATH_KEY] = undefined;
                } catch (err) {
                    if (err.code !== 'ENOENT') {
                        record[HDB_PATH_KEY] = undefined;
                    }
                }
            }
        })
    );

    return records;
};