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
        let attributes_data = {};
        let hash_values = [];

        const { schema, table } = search_object;
        let table_path = `${getBasePath()}/${schema}/${table}`;

        if (!common_utils.isEmpty(hash_results)) {
            hash_values = hash_results;
        } else {
            hash_values = await validateHashValuesExist(table_path, hash_attr, search_object.hash_values);
        }

        //if there are no valid hash values to find attribute values for, return an empty attr data obj
        if (common_utils.isEmptyOrZeroLength(hash_values)) {
            return attributes_data;
        }

        if (hash_values.length > RAW_FILE_READ_LIMIT) {
            //TODO - add logic for scanning attr value dir
            //START
            let blob_paths = {};
            await Promise.all(get_attributes.map(async attr => {
                try {
                    // let sub_path = common_utils.buildFolderPath(schema, table, attr);

                    let attribute_path = common_utils.buildFolderPath(table_path, attr);
                    let results = await fs.readdir(attribute_path);
                    await Promise.all(results.map(async value => {
                        try {
                            //TODO - use new approach to cleaning up values and ids below
                            let the_value = common_utils.autoCast(value.replace(escaped_slash_regex, '/'));
                            let ids = await fs.readdir(common_utils.buildFolderPath(attribute_path,value));
                            for (let id of ids) {
                                if (id===BLOB_FOLDER_NAME) {
                                    //TODO - should probably just do a deeper search here instead of add to the blob obj
                                    let blob_path = common_utils.buildFolderPath(sub_path, value);
                                    if (!blob_paths[blob_path]) {
                                        blob_paths[blob_path] = column;
                                    }
                                } else {
                                    //TODO - use new approach to cleaning up values and ids below

                                    let the_id = common_utils.autoCast(this._stripFileExtension(id));
                                    let the_key = this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id];
                                    if (the_key) {
                                        this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id][column.attribute] = the_value;
                                    }
                                }
                            }
                        } catch (e) {
                            log.error(e);
                        }

                        if (!_.isEmpty(blob_paths)) {
                            await this._readBlobFiles(blob_paths).catch(e => {
                                log.error(e);
                            });
                        }
                    }));
                } catch (e) {
                    log.error(e);
                }

            }));


            //END
        } else {
            for (const attribute of get_attributes) {
                //evaluate if an array of strings or objects has been passed in and assign values accordingly
                const attribute_name = (typeof attribute === 'string') ? attribute : attribute.attribute;
                const is_hash = attribute_name === hash_attr;
                //if attribute is the hash value, assign hash_result values to hash
                if (is_hash) {
                    let hash_attr_data = {};
                    for (const file of hash_values) {
                        hash_attr_data[file] = common_utils.autoCast(file);
                    }
                    attributes_data[attribute_name] = hash_attr_data;
                } else {
                    const attribute_file_values = await readAttributeFiles(table_path, attribute_name, hash_values);
                    if (!_.isEmpty(attribute_file_values)) {
                        attributes_data[attribute_name] = attribute_file_values;
                    }
                }
            }
        }

        return attributes_data;
    } catch(err) {
        throw err;
    }
}

async function readAttributeFilePromise(table_path, attribute, file, attribute_data, is_hash) {
    try {
        const data = await fs.readFile(`${table_path}/${hdb_terms.HASH_FOLDER_NAME}/${attribute}/${file}${hdb_terms.HDB_FILE_SUFFIX}`, 'utf-8');
        const value = common_utils.autoCast(data.toString());
        attribute_data[file] = value;
    } catch (err) {
        if (err.code === 'ENOENT') {
            if (!is_hash) {
                attribute_data[file] = null;
            }
        } else {
            throw(err);
        }
    }
}

async function readAttributeFiles(table_path, attribute, hash_files, is_hash) {
    try {
        let attribute_data = {};
        const readFileOps = [];

        for (const file of hash_files) {
            readFileOps.push(readAttributeFilePromise(table_path, attribute, file, attribute_data, !!is_hash));
        }

        await Promise.all(readFileOps);

        return attribute_data;
    } catch(err) {
        throw err;
    }
}

async function validateHashValuesExist(table_path, hash_attr, hash_files) {
    // const valid_hashes = await readAttributeFiles(table_path, hash_attr, hash_files, true);
    // return Object.values(valid_hashes);
    const hash_path = common_utils.buildFolderPath(table_path, hdb_terms.HASH_FOLDER_NAME, hash_attr);
    let existing_values = [];
    await Promise.all(hash_files.map(async value => {
        try {
            await fs.access(common_utils.buildFolderPath(hash_path, value + hdb_terms.HDB_FILE_SUFFIX), fs.constants.F_OK);
            existing_values.push(value);
        } catch (e) {
            log.error(e);
            // no-op
        }
    }));
    return existing_values;
}