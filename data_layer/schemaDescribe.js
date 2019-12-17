//this is to avoid a circular dependency with insert.  insert needs the describe all function but so does the main schema module.  as such the functions have been broken out into a seperate module.
const search = require('./search');
const logger = require('../utility/logging/harper_logger');
const validator = require('../validation/schema_validator');
const _ = require('lodash');
const hdb_utils = require('../utility/common_utils');
const {promisify} = require('util');
const terms = require('../utility/hdbTerms');

// Promisified functions
let p_search_search_by_value = promisify(search.searchByValue);

const NAME_ATTRIBUTE_STRING = 'name';
const HASH_ATTRIBUTE_STRING = 'hash_attribute';
const SCHEMA_ATTRIBUTE_STRING = 'schema';
const SCHEMA_TABLE_ATTRIBUTE_STRING = 'schema_table';
const ATTRIBUTE_NAME_STRING = 'attribute';

module.exports = {
    describeAll,
    describeTable: descTable,
    describeSchema
};

async function describeAll(op_obj) {
    try {
        let schema_search = {};
        schema_search.schema = terms.SYSTEM_SCHEMA_NAME;
        schema_search.table = terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME;
        schema_search.hash_attribute = terms.SYSTEM_TABLE_HASH_ATTRIBUTES.SCHEMA_TABLE_HASH_ATTRIBUTE;
        schema_search.search_attribute = NAME_ATTRIBUTE_STRING;
        schema_search.search_value = terms.WILDCARD_SEARCH_VALUE;
        schema_search.hash_values = [];
        schema_search.get_attributes = [NAME_ATTRIBUTE_STRING];
        let schemas = await p_search_search_by_value(schema_search);

        if (hdb_utils.isEmptyOrZeroLength(schemas)) {
            return {};
        }

        let schema_list = {};
        for (let s in schemas) {
            schema_list[schemas[s].name] = true;
        }

        let table_search_obj = {};
        table_search_obj.schema = terms.SYSTEM_SCHEMA_NAME;
        table_search_obj.table = terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME;
        table_search_obj.hash_attribute = terms.SYSTEM_TABLE_HASH_ATTRIBUTES.TABLE_TABLE_HASH_ATTRIBUTE;
        table_search_obj.search_attribute = terms.ID_ATTRIBUTE_STRING;
        table_search_obj.search_value = terms.WILDCARD_SEARCH_VALUE;
        table_search_obj.hash_values = [];
        table_search_obj.get_attributes = [HASH_ATTRIBUTE_STRING, terms.ID_ATTRIBUTE_STRING, NAME_ATTRIBUTE_STRING, SCHEMA_ATTRIBUTE_STRING];

        let tables = await p_search_search_by_value(table_search_obj);

        let t_results = [];
        await Promise.all(
            tables.map(async (table) => {
                try {
                    let desc = await descTable({"schema": table.schema, "table": table.name});
                    if (desc) {
                        t_results.push(desc);
                    }
                } catch (e) {
                    logger.error(e);
                }
            })
        );
        let hdb_description = {};
        for (let t in t_results) {
            if (hdb_description[t_results[t].schema] == null) {
                hdb_description[t_results[t].schema] = {};
            }

            hdb_description[t_results[t].schema][t_results[t].name] = t_results[t];
            if (schema_list[t_results[t].schema]) {
                delete schema_list[t_results[t].schema];
            }
        }

        for (let schema in schema_list) {
            hdb_description[schema] = {};
        }
        return hdb_description;
    } catch (e) {
        logger.error('Got an error in describeAll');
        logger.error(e);
        return new Error("There was an error during describeAll.  Please check the logs and try again.");
    }
}

async function descTable(describe_table_object) {
    let table_result = {};
    let validation = validator.describe_table(describe_table_object);
    if (validation) {
        throw validation;
    }
    if (describe_table_object.schema === 'system') {
        return global.hdb_schema['system'][describe_table_object.table];
    }

    let table_search_obj = {};
    table_search_obj.schema = terms.SYSTEM_SCHEMA_NAME;
    table_search_obj.table = terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME;
    table_search_obj.hash_attribute = terms.SYSTEM_TABLE_HASH_ATTRIBUTES.TABLE_TABLE_HASH_ATTRIBUTE;
    table_search_obj.search_attribute = NAME_ATTRIBUTE_STRING;
    table_search_obj.search_value = describe_table_object.table;
    table_search_obj.hash_values = [];
    table_search_obj.get_attributes = [terms.WILDCARD_SEARCH_VALUE];

    let tables = await p_search_search_by_value(table_search_obj);

    if (!tables || tables.length === 0) {
        throw new Error("Invalid table");
    }

    await Promise.all(
        tables.map(async (table) => {
            try {
                if (table.schema === describe_table_object.schema) {
                    table_result = table;
                }
                if (!table_result.hash_attribute) {
                    throw new Error("Invalid table");
                }

                let attribute_search_obj = {};
                attribute_search_obj.schema = terms.SYSTEM_SCHEMA_NAME;
                attribute_search_obj.table = terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME;
                attribute_search_obj.hash_attribute = terms.SYSTEM_TABLE_HASH_ATTRIBUTES.ATTRIBUTE_TABLE_HASH_ATTRIBUTE;
                attribute_search_obj.search_attribute = SCHEMA_TABLE_ATTRIBUTE_STRING;
                attribute_search_obj.search_value = describe_table_object.schema + "." + describe_table_object.table;
                attribute_search_obj.get_attributes = [ATTRIBUTE_NAME_STRING];

                let attributes = await p_search_search_by_value(attribute_search_obj);
                attributes = _.uniqBy(attributes, (attribute) => {
                    return attribute.attribute;
                });

                table_result.attributes = attributes;
            } catch (err) {
                logger.error('There was an error getting table attributes.');
                logger.error(err);
            }
        })
    );
    return table_result;
}

async function describeSchema(describe_schema_object) {
    let validation_msg = validator.schema_object(describe_schema_object);
    if (validation_msg) {
        throw validation_msg;
    }
    let table_search_obj = {};
    table_search_obj.schema = terms.SYSTEM_SCHEMA_NAME;
    table_search_obj.table = terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME;
    table_search_obj.hash_attribute = terms.SYSTEM_TABLE_HASH_ATTRIBUTES.TABLE_TABLE_HASH_ATTRIBUTE;
    table_search_obj.search_attribute = SCHEMA_ATTRIBUTE_STRING;
    table_search_obj.search_value = describe_schema_object.schema;
    table_search_obj.hash_values = [];
    table_search_obj.get_attributes = [HASH_ATTRIBUTE_STRING, terms.ID_ATTRIBUTE_STRING, NAME_ATTRIBUTE_STRING, SCHEMA_ATTRIBUTE_STRING];

    let tables = await p_search_search_by_value(table_search_obj);

    if (tables && tables.length < 1) {
        let schema_search_obj = {};
        schema_search_obj.schema = terms.SYSTEM_SCHEMA_NAME;
        schema_search_obj.table = terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME;
        schema_search_obj.hash_attribute = terms.SYSTEM_TABLE_HASH_ATTRIBUTES.SCHEMA_TABLE_HASH_ATTRIBUTE;
        schema_search_obj.hash_values = [describe_schema_object.schema];
        schema_search_obj.get_attributes = [NAME_ATTRIBUTE_STRING];
        schema_search_obj.search_value = terms.WILDCARD_SEARCH_VALUE;
        schema_search_obj.search_attribute = terms.WILDCARD_SEARCH_VALUE;

        let schema = await p_search_search_by_value(schema_search_obj);
        if (schema && schema.length < 1) {
            throw new Error('schema not found');
        } else {
            return {};
        }
    } else {
        let results = [];
        await Promise.all(
            tables.map(async (table) => {
                try {
                    let data = await descTable({"schema": describe_schema_object.schema, "table": table.name});
                    if (data) {
                        results.push(data);
                    }
                } catch (err) {
                    logger.error('Error describing table.');
                    logger.error(err);
                }
            })
        );
        return results;
    }
}