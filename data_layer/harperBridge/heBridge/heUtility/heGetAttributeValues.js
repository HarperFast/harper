"use strict";

// const common_utils = require('../../../../utility/common_utils');
// const hdb_terms = require('../../../../utility/hdbTerms');
const heliumUtil = require('../../../../utility/helium/heliumUtils');

module.exports = heGetAttributeValues;

function heGetAttributeValues(hash_values, data_stores) {
    try {
        // TODO: remove helium references here after helium initialization process is figured out
        const helium = heliumUtil.initializeHelium();
        const search_results = helium.searchByKeys(hash_values, data_stores);
        heliumUtil.terminateHelium(helium);

        return search_results;
    } catch(err) {
        throw err;
    }
}

// async function readAttributeFilePromise(table_path, attribute, file, attribute_data) {
//     try {
//         const data = await fs.readFile(`${table_path}/${hdb_terms.HASH_FOLDER_NAME}/${attribute}/${file}${hdb_terms.HDB_FILE_SUFFIX}`, 'utf-8');
//         const value = common_utils.autoCast(data.toString());
//         attribute_data[file] = value;
//     } catch (err) {
//         if (err.code !== 'ENOENT') {
//             throw(err);
//         }
//     }
// }
//
// async function readAttributeValues(table_path, attribute, hash_files) {
//     try {
//         let attribute_data = {};
//
//         const readFileOps = [];
//         for (const file of hash_files) {
//             readFileOps.push(readAttributeFilePromise(table_path, attribute, file, attribute_data));
//         }
//
//         await Promise.all(readFileOps);
//         return attribute_data;
//     } catch(err) {
//         throw err;
//     }
// }