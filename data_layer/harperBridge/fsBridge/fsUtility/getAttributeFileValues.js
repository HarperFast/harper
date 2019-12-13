"use strict";

const _ = require('lodash');
const fs = require('fs-extra');

const common_utils = require('../../../../utility/common_utils');
const getBasePath = require('./getBasePath');
const hdb_terms = require('../../../../utility/hdbTerms');
const log = require('../../../../utility/logging/harper_logger');

module.exports = getAttributeFileValues;

const RAW_FILE_READ_LIMIT = 1000;
const BLOB_FOLDER_NAME = 'blob';

async function getAttributeFileValues(get_attributes, search_object, hash_attr, hash_results) {
    try {
        let final_attributes_data = {};
        let hash_values = [];

        const {schema, table} = search_object;
        let table_path = `${getBasePath()}/${schema}/${table}`;

        if (!common_utils.isEmpty(hash_results)) {
            hash_values = hash_results;
        } else {
            hash_values = await validateHashValuesExist(table_path, hash_attr, search_object.hash_values);
        }

        //if there are no valid hash values to find attribute values for, return an empty attr data obj
        if (common_utils.isEmptyOrZeroLength(hash_values)) {
            return final_attributes_data;
        }

        const hash_requested = get_attributes.includes(hash_attr);

        //Check for most performant approach for values lookup
        if (hash_values.length > RAW_FILE_READ_LIMIT) {
            //If there are more than 1000 hashes, scan attr value directories for matching hashes for value lookup
            //Need to create a row template with each attribute to ensure final results include NULL attr values
            const row_value_template = get_attributes.reduce((acc, attr) => {
                acc[attr] = null;
                return acc;
            }, {});

            //Create final result object with row templates that will be updated if hash values are found in attr value dir scan
            final_attributes_data = hash_values.reduce((acc, hash) => {
                acc[hash] = Object.assign({}, row_value_template);
                if (hash_requested) {
                    acc[hash][hash_attr] = common_utils.autoCast(hash);
                }
                return acc;
            }, {});

            for (const attr of get_attributes) {
                try {
                    if (attr === hash_attr) {
                        //no-op - can skip b/c hash values already added in reduce function above
                        continue;
                    } else {
                        const attribute_path = common_utils.buildFolderPath(table_path, attr);
                        //Get attr  values from readdir on attr value dir then do readdir on each of those value dirs to get hash values for each
                        const results = await fs.readdir(attribute_path);
                        for (const value of results) {
                            try {
                                const the_value = common_utils.unescapeValue(value);
                                const attr_value_path = common_utils.buildFolderPath(attribute_path, value);

                                const ids = await fs.readdir(attr_value_path);
                                for (let id of ids) {
                                    //Check if value is a blob folder instead of a hash file
                                    if (id === BLOB_FOLDER_NAME) {
                                        try {
                                            const blob_path = common_utils.buildFolderPath(attr_value_path, BLOB_FOLDER_NAME);
                                            const blob_ids = await fs.readdir(blob_path);

                                            if (!blob_ids || blob_ids.length === 0) {
                                                return;
                                            }
                                            for (const blob_id of blob_ids) {
                                                try {
                                                    const the_id = common_utils.autoCast(common_utils.stripFileExtension(blob_id));
                                                    const hash_included = !!final_attributes_data[the_id];
                                                    if (hash_included) {
                                                        const file_data = await fs.readFile(common_utils.buildFolderPath(blob_path, blob_id), 'utf-8');
                                                        final_attributes_data[the_id][attr] = file_data;
                                                    }
                                                } catch (e) {
                                                    log.error(e);
                                                }
                                            }
                                        } catch (e) {
                                            log.error(e);
                                        }
                                    } else {
                                        //Check if hash value is in requested hashes and, if so, add hash/value pair to final results
                                        const the_id = common_utils.autoCast(common_utils.stripFileExtension(id));
                                        const hash_included = final_attributes_data[the_id];
                                        if (hash_included) {
                                            final_attributes_data[the_id][attr] = common_utils.autoCast(the_value);
                                        }
                                    }
                                }
                            } catch (e) {
                                log.error(e);
                            }
                        }
                    }
                } catch (e) {
                    log.error(e);
                }
            }
        } else {
            //If there are less than or equal to 1000 hashes, find values via hash file read
            final_attributes_data = hash_values.reduce((acc, hash) => {
                acc[hash] = {};
                if (hash_requested) {
                    acc[hash][hash_attr] = common_utils.autoCast(hash);
                }
                return acc;
            }, {});
            for (const attribute of get_attributes) {
                //evaluate if an array of strings or objects has been passed in and assign values accordingly
                const attribute_name = (typeof attribute === 'string') ? attribute : attribute.attribute;
                const is_hash = attribute_name === hash_attr;
                //if attribute is the hash value, assign hash_result values to hash
                if (is_hash) {
                    continue;
                } else {
                    await readAttributeFiles(table_path, attribute_name, hash_values, final_attributes_data);
                }
            }
        }

        return final_attributes_data;
    } catch(err) {
        throw err;
    }
}

async function readAttributeFilePromise(table_path, attribute, file, final_attributes_data) {
    try {
        const data = await fs.readFile(`${table_path}/${hdb_terms.HASH_FOLDER_NAME}/${attribute}/${file}${hdb_terms.HDB_FILE_SUFFIX}`, 'utf-8');
        const attr_value = common_utils.autoCast(data);
        final_attributes_data[file][attribute] = attr_value;
    } catch (err) {
        if (err.code === 'ENOENT') {
            final_attributes_data[file][attribute] = null;
        } else {
            throw(err);
        }
    }
}

async function readAttributeFiles(table_path, attribute, hash_files, final_attributes_data) {
    const readFileOps = [];
    for (const file of hash_files) {
        readFileOps.push(readAttributeFilePromise(table_path, attribute, file, final_attributes_data));
    }

    await Promise.all(readFileOps);
}

async function validateHashValuesExist(table_path, hash_attr, hash_files) {
    if (common_utils.isEmptyOrZeroLength(hash_files)){
        return [];
    }
    const hash_path = common_utils.buildFolderPath(table_path, hdb_terms.HASH_FOLDER_NAME, hash_attr);
    let existing_hash_values = [];
    await Promise.all(hash_files.map(async value => {
        try {
            await fs.access(common_utils.buildFolderPath(hash_path, value + hdb_terms.HDB_FILE_SUFFIX), fs.constants.F_OK);
            existing_hash_values.push(value);
        } catch (e) {
            log.error(e);
            // no-op
        }
    }));

    return existing_hash_values;
}