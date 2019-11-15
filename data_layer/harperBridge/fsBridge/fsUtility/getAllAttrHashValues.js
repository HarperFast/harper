"use strict";

const _ = require('lodash');
const fs = require('fs-extra');

const common_utils = require('../../../../utility/common_utils');
const log = require('../../../../utility/logging/harper_logger');

module.exports = getAllAttrHashValues;

async function getAllAttrHashValues(search_path) {
    try {
        const results = await fs.readdir(search_path);
        let final_hash_results = [];
        if (common_utils.isEmptyOrZeroLength(results)) {
            return final_hash_results;
        } else {
            final_hash_results = results.map(hash_file => common_utils.autoCast(common_utils.stripFileExtension(hash_file)));
            return final_hash_results;
        }
    } catch (e) {
        log.error(e);
    }
}