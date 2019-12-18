"use strict";

const _ = require('lodash');
const fs = require('fs-extra');

const common_utils = require('../../../../utility/common_utils');
const log = require('../../../../utility/logging/harper_logger');

module.exports = getAllAttrHashValues;

async function getAllAttrHashValues(hash_dir_path) {
    let final_hash_results = [];
    try {
        const hash_results = await fs.readdir(hash_dir_path);
        if (common_utils.isEmptyOrZeroLength(hash_results)) {
            return final_hash_results;
        } else {
            for (let i = 0; i < hash_results.length; i++) {
                final_hash_results.push(common_utils.autoCast(common_utils.stripFileExtension(hash_results[i])));
            }
        }
    } catch(e) {
        log.error(e);
    }

    return final_hash_results;
}