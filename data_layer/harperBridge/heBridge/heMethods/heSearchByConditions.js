"use strict";

const _ = require('lodash');
const async = require('async');
const common_utils = require('../../../../utility/common_utils');
const logger = require('../../../../utility/logging/harper_logger');
const util = require('util');
const hdb_terms = require('../../../../utility/hdbTerms');
const system_schema = require('../../../../json/systemSchema.json');

const heGetDataByValue = require('../heMethods/heGetDataByValue');
const heSearchByHash = require('../heMethods/heSearchByHash');

const search_validator = require('../../../../validation/searchValidator.js');

module.exports = heSearchByConditions;

// Search Object
// {
//   schema:String, // schema to search
//   table:String, // table to search
//   conditions: Array // search condition to filter rows on
//   get_attributes:Array // attributes to return with search result
// }

const p_multiConditionSearch = util.promisify(multiConditionSearch);

async function heSearchByConditions(search_object) {
    try {
        let validation_error = search_validator(search_object, 'conditions');

        if (validation_error) {
            throw validation_error;
        }

        const final_hash_results = await p_multiConditionSearch(search_object);

        if (common_utils.isEmptyOrZeroLength(final_hash_results)) {
            return [];
        }
        const final_search_object = {
            schema: search_object.schema,
            table: search_object.table,
            hash_values: final_hash_results,
            get_attributes: search_object.get_attributes
        };
        const final_results = heSearchByHash(final_search_object);

        return final_results;
    } catch(err){
        throw err;
    }
}

function multiConditionSearch(search_object, callback) {
    try {
        const { schema, table, conditions } = search_object;
        let hash_attr;

        if (schema === hdb_terms.SYSTEM_SCHEMA_NAME) {
            hash_attr = system_schema[table].hash_attribute;
        } else {
            hash_attr = global.hdb_schema[schema][table].hash_attribute;
        }

        let all_ids = [];
        async.forEachOf(conditions, (condition, key, caller) => {
            all_ids[key] = {};
            let condition_key = Object.keys(condition)[0];
            if (condition_key === 'and' || condition_key === 'or') {
                all_ids[key].operation = condition_key;
                condition = condition[condition_key];
            }
            const comparators = Object.values(condition)[0];

            const val_search_object = {
                schema: schema,
                table: table,
                search_attribute: comparators[0],
                search_value: String(comparators[1]),
                get_attributes: [hash_attr]
            };

            let val_search_result;
            try {
                val_search_result = Object.keys(heGetDataByValue(val_search_object));
                all_ids[key].ids = val_search_result;
            } catch(err) {
                logger.error(err);
            }
            caller();
        },err => {
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