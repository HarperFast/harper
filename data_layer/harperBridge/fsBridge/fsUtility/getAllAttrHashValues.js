"use strict";

const fs = require('fs-extra');

const common_utils = require('../../../../utility/common_utils');
const log = require('../../../../utility/logging/harper_logger');
const hdb_terms = require('../../../../utility/hdbTerms');

module.exports = getAllAttrHashValues;

async function getAllAttrHashValues(hash_dir_path) {
    let final_hash_results = [];
    try {
        const hash_results = await fs.readdir(hash_dir_path);
        if (common_utils.isEmptyOrZeroLength(hash_results)) {
            return final_hash_results;
        }

        for (let i = 0; i < hash_results.length; i++) {
            final_hash_results.push(common_utils.autoCast(common_utils.stripFileExtension(hash_results[i])));
        }
    } catch(e) {
        if (e.code !== hdb_terms.NODE_ERROR_CODES.ENOENT) {
            log.error(e);
        }
    }

    return final_hash_results;
}