"use strict";

const _ = require('lodash');
const async = require('async');
const logger = require('../../../../utility/logging/harper_logger');
const util = require('util');

const consolidateSearchData = require('../fsUtility/consolidateSearchData');
const evaluateTableGetAttributes = require('../../bridgeUtility/evaluateTableGetAttributes');
const getAttributeFileValues = require('../fsUtility/getAttributeFileValues');
const getBasePath = require('../fsUtility/getBasePath');

const condition_patterns = require('../../../../sqlTranslator/conditionPatterns');
const search_validator = require('../../../../validation/searchValidator.js');

const file_search = require('../../../../lib/fileSystem/fileSearch');

module.exports = fsSearchByConditions;

// Search Object
// {
//   schema:String, // schema to search
//   table:String, // table to search
//   conditions: Array // search condition to filter rows on
//   get_attributes:Array // attributes to return with search result
// }

const p_multiConditionSearch = util.promisify(multiConditionSearch);

async function fsSearchByConditions(search_object) {
    try {
        let validation_error = search_validator(search_object, 'conditions');

        if (validation_error) {
            throw validation_error;
        }

        let table_info = global.hdb_schema[search_object.schema][search_object.table];

        const final_get_attrs = evaluateTableGetAttributes(search_object.get_attributes, table_info.attributes);
        const final_hash_results = await p_multiConditionSearch(search_object.conditions, table_info);

        const final_attributes_data = await getAttributeFileValues(final_get_attrs, search_object, final_hash_results);
        const final_results = consolidateSearchData(table_info.hash_attribute, final_attributes_data);

        return Object.values(final_results);
    } catch(err){
        throw err;
    }
}

function multiConditionSearch(conditions, table_schema, callback) {
    try {
        let all_ids = [];

        async.forEachOf(conditions, (condition, key, caller) => {
            all_ids[key] = {};
            let condition_key = Object.keys(condition)[0];
            if (condition_key === 'and' || condition_key === 'or') {
                all_ids[key].operation = condition_key;
                condition = condition[condition_key];
            }

            let pattern = condition_patterns.createPatterns(condition, table_schema, getBasePath());

            file_search.findIDsByRegex(pattern.folder_search_path, pattern.folder_search, pattern.blob_search, (err, results) => {
                if (err) {
                    logger.error(err);
                } else {
                    all_ids[key].ids = results;
                }
                caller();
            });
        }, err => {
            if (err) {
                callback(err);
                return;
            }

            let matched_ids = all_ids[0].ids;
            all_ids.shift();
            all_ids.forEach((ids) => {
                if (!ids.operation || ids.operation === 'or') {
                    matched_ids = matched_ids.concat(ids.ids);
                } else {
                    matched_ids = _.intersection(matched_ids, ids.ids);
                }
            });
            if (matched_ids.length === 0) {
                callback(null, matched_ids);
                return;
            }

            callback(null, _.uniq(matched_ids));
        });
    } catch(e){
        callback(e);
    }
}