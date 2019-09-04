'use strict';

const fsSearchByHash = require('./fsSearchByHash');
const insertUpdateValidate = require('../fsUtility/insertUpdateValidate');
const processRows = require('../fsUtility/processRows');
const processData = require('../fsUtility/processData');
const unlink = require('../../../../utility/fs/unlink');
const hdb_utils = require('../../../../utility/common_utils');
const log = require('../../../../utility/logging/harper_logger');
const _ = require('lodash');
const checkForNewAttributes = require('../fsUtility/checkForNewAttr');

const UPDATE_ACTION = 'updated';

module.exports = updateRecords;

async function updateRecords(update_obj) {
    try {
        let { schema_table, hashes, attributes } = insertUpdateValidate(update_obj);
        let existing_rows = await getExistingRows(schema_table, hashes, attributes);

        // If no hashes are existing skip update attempts
        if (hdb_utils.isEmptyOrZeroLength(existing_rows)){
            return {
                existing_rows,
                update_action: UPDATE_ACTION,
                hashes
            };
        }

        let existing_map = _.keyBy(existing_rows, function(record) {
            return record[schema_table.hash_attribute];
        });
        let data_wrapper = await processRows(update_obj, attributes, schema_table, existing_map);
        await checkForNewAttributes(update_obj.hdb_auth_header, schema_table, attributes);
        await unlinkFiles(data_wrapper.unlinks);
        await processData(data_wrapper);

        return {
            written_hashes: data_wrapper.written_hashes,
            skipped_hashes: data_wrapper.skipped_hashes,
            schema_table
        };
    } catch(err) {
        log.error(err);
        throw err;
    }
}

/**
 * performs a bulk search_by_hash for the defined hashes
 * @param schema_table
 * @param hashes
 * @param attributes
 * @returns {Promise<void>}
 */
async function getExistingRows(schema_table, hashes, attributes){
    try {
        let existing_attributes = checkForExistingAttributes(schema_table, attributes);
        if (hdb_utils.isEmptyOrZeroLength(existing_attributes)) {
            throw new Error('no attributes to update');
        }

        let search_object = {
            schema: schema_table.schema,
            table: schema_table.name,
            hash_values: hashes,
            get_attributes: existing_attributes
        };

        let existing_records = await fsSearchByHash(search_object);
        return existing_records;
    } catch(err) {
        log.error(err);
        throw err;
    }
}

/**
 * Compares the existing schema attributes to attributes from a record set and returns only the ones that exist
 * @param schema_table
 * @param data_attributes
 * @returns {*[]}
 */
function checkForExistingAttributes(schema_table, data_attributes){
    if(hdb_utils.isEmptyOrZeroLength(data_attributes)){
        return;
    }

    let raw_attributes = [];
    if(!hdb_utils.isEmptyOrZeroLength(schema_table.attributes)){
        schema_table.attributes.forEach((attribute)=>{
            raw_attributes.push(attribute.attribute);
        });
    }

    let existing_attributes = data_attributes.filter(attribute =>{
        return raw_attributes.indexOf(attribute) >= 0;
    });

    return existing_attributes;
}

/**
 * deletes files in bulk
 * @param unlink_paths
 */
async function unlinkFiles(unlink_paths) {
    try {
        await unlink(unlink_paths);
    } catch(err) {
        log.error(err);
    }
}
