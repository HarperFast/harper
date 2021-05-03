"use strict";

//this is to avoid a circular dependency with insert.  insert needs the describe all function but so does the main schema module.  as such the functions have been broken out into a separate module.
const search = require('./search');
const logger = require('../utility/logging/harper_logger');
const validator = require('../validation/schema_validator');
const _ = require('lodash');
const path = require('path');
const hdb_utils = require('../utility/common_utils');
const {promisify} = require('util');
const terms = require('../utility/hdbTerms');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;
const env_mngr = require('../utility/environment/environmentManager');
if(!env_mngr.isInitialized()){
    env_mngr.initSync();
}
const lmdb_environment_utility = require('../utility/lmdb/environmentUtility');
const lmdb_init_paths = require('../data_layer/harperBridge/lmdbBridge/lmdbUtility/initializePaths');

// Promisified functions
let p_search_search_by_value = promisify(search.searchByValue);
let p_search_search_by_hash = promisify(search.searchByHash);

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

/**
 * This method is exposed to the API and internally for system operations.  If the op is being made internally, the `op_obj`
 * argument is not passed and, therefore, no permissions are used to filter the final schema metadata results.
 * @param op_obj
 * @returns {Promise<{}|HdbError>}
 */
async function describeAll(op_obj) {
    try {
        const sys_call = hdb_utils.isEmptyOrZeroLength(op_obj);
        let role_perms;
        let is_su;
        if (!sys_call) {
            role_perms = op_obj.hdb_user.role.permission;
            is_su = role_perms.super_user || role_perms.cluster_user;
        }

        let schema_search = {};
        schema_search.schema = terms.SYSTEM_SCHEMA_NAME;
        schema_search.table = terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME;
        schema_search.search_attribute = NAME_ATTRIBUTE_STRING;
        schema_search.search_value = terms.WILDCARD_SEARCH_VALUE;
        schema_search.get_attributes = [NAME_ATTRIBUTE_STRING];
        let schemas = await p_search_search_by_value(schema_search);

        if (hdb_utils.isEmptyOrZeroLength(schemas)) {
            return {};
        }

        let schema_list = {};
        let schema_perms = {};
        for (let s in schemas) {
            schema_list[schemas[s].name] = true;
            if (!sys_call && !is_su) {
                schema_perms[schemas[s].name] = role_perms[schemas[s].name].describe;
            }
        }

        let table_search_obj = {};
        table_search_obj.schema = terms.SYSTEM_SCHEMA_NAME;
        table_search_obj.table = terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME;
        table_search_obj.search_attribute = terms.ID_ATTRIBUTE_STRING;
        table_search_obj.search_value = terms.WILDCARD_SEARCH_VALUE;
        table_search_obj.get_attributes = [HASH_ATTRIBUTE_STRING, terms.ID_ATTRIBUTE_STRING, NAME_ATTRIBUTE_STRING, SCHEMA_ATTRIBUTE_STRING];

        let tables = await p_search_search_by_value(table_search_obj);

        let t_results = [];
        for(let table of tables){
            try {
                let desc;
                if (sys_call || is_su) {
                    desc = await descTable({"schema": table.schema, "table": table.name});
                } else if (role_perms && role_perms[table.schema].describe && role_perms[table.schema].tables[table.name].describe) {
                    const t_attr_perms = role_perms[table.schema].tables[table.name].attribute_permissions;
                    desc = await descTable({"schema": table.schema, "table": table.name}, t_attr_perms );
                }
                if (desc) {
                    t_results.push(desc);
                }
            } catch (e) {
                logger.error(e);
            }
        }

        let hdb_description = {};
        for (let t in t_results) {
            if (sys_call || is_su) {
                if (hdb_description[t_results[t].schema] == null) {
                    hdb_description[t_results[t].schema] = {};
                }

                hdb_description[t_results[t].schema][t_results[t].name] = t_results[t];
                if (schema_list[t_results[t].schema]) {
                    delete schema_list[t_results[t].schema];
                }
            } else if (schema_perms[t_results[t].schema]) {
                if (hdb_description[t_results[t].schema] == null) {
                    hdb_description[t_results[t].schema] = {};
                }

                hdb_description[t_results[t].schema][t_results[t].name] = t_results[t];
                if (schema_list[t_results[t].schema]) {
                    delete schema_list[t_results[t].schema];
                }
            }

        }

        for (let schema in schema_list) {
            if (sys_call || is_su) {
                hdb_description[schema] = {};
            } else if (schema_perms[schema]) {
                hdb_description[schema] = {};
            }
        }
        return hdb_description;
    } catch (e) {
        logger.error('Got an error in describeAll');
        logger.error(e);
        return handleHDBError(new Error(), HDB_ERROR_MSGS.DESCRIBE_ALL_ERR);
    }
}

/**
 * This method will return the metadata for a table - if `attr_perms` are passed as an argument (or included in the `describe_table_object` arg),
 * the final results w/ be filtered based on those permissions
 *
 * @param describe_table_object
 * @param attr_perms - optional - permissions for the role requesting metadata for the table used when chained to other
 * internal operations.  If this method is hit via the API, perms will be grabbed from the describe_table_object which
 * includes the users role and permissions.
 * @returns {Promise<{}|*>}
 */
async function descTable(describe_table_object, attr_perms) {
    const { schema, table } = describe_table_object;
    let table_attr_perms = attr_perms;

    //If the describe_table_object includes a `hdb_user` value, it is being called from the API and we can grab the user's
    // role permissions from there
    if (describe_table_object.hdb_user && !describe_table_object.hdb_user.role.permission.super_user) {
        table_attr_perms = describe_table_object.hdb_user.role.permission[schema].tables[table].attribute_permissions;
    }

    let table_result = {};
    let validation = validator.describe_table(describe_table_object);
    if (validation) {
        throw validation;
    }
    if (describe_table_object.schema === terms.SYSTEM_SCHEMA_NAME) {
        return global.hdb_schema[terms.SYSTEM_SCHEMA_NAME][describe_table_object.table];
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
        throw handleHDBError(new Error(), HDB_ERROR_MSGS.TABLE_NOT_FOUND(describe_table_object.schema,
            describe_table_object.table), HTTP_STATUS_CODES.NOT_FOUND);
    }

    let describe_table_obj_schema = hdb_utils.autoCast(describe_table_object.schema);

    for await (let table1 of tables) {
        try {
            if (table1.schema !== describe_table_obj_schema) {
                continue;
            }
            table_result = table1;

            if (!table_result.hash_attribute) {
                throw handleHDBError(new Error(), HDB_ERROR_MSGS.INVALID_TABLE_ERR(table_result));
            }

            let attribute_search_obj = {};
            attribute_search_obj.schema = terms.SYSTEM_SCHEMA_NAME;
            attribute_search_obj.table = terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME;
            attribute_search_obj.hash_attribute = terms.SYSTEM_TABLE_HASH_ATTRIBUTES.ATTRIBUTE_TABLE_HASH_ATTRIBUTE;
            attribute_search_obj.search_attribute = SCHEMA_TABLE_ATTRIBUTE_STRING;
            attribute_search_obj.search_value = describe_table_object.schema + "." + describe_table_object.table;
            attribute_search_obj.get_attributes = [ATTRIBUTE_NAME_STRING];

            let attributes = await p_search_search_by_value(attribute_search_obj);
            attributes = _.uniqBy(attributes, (attribute) => attribute.attribute);

            if (table_attr_perms && table_attr_perms.length > 0) {
                attributes = getAttrsByPerms(table_attr_perms);
            }

            table_result.attributes = attributes;

            if(env_mngr.getDataStoreType() === terms.STORAGE_TYPES_ENUM.LMDB){
                try {
                    let schema_path = path.join(lmdb_init_paths.getBaseSchemaPath(), table_result.schema.toString());
                    let env = await lmdb_environment_utility.openEnvironment(schema_path, table_result.name);
                    let dbi_stat = lmdb_environment_utility.statDBI(env, table_result.hash_attribute);
                    table_result.record_count = dbi_stat.entryCount;
                }catch(e){
                    logger.warn(`unable to stat table dbi due to ${e}`);
                }
            }

        } catch (err) {
            logger.error(`There was an error getting attributes for table '${table1.name}'`);
            logger.error(err);
        }
    }
    return table_result;
}

/**
 * Takes permissions for the table and returns the attributes that that have describe === true
 *
 * @param attr_perms - table attribute permissions for the role calling the describe op
 * @returns {*} -  a filtered object of attributes that can be returned in the describe operation
 */
function getAttrsByPerms(attr_perms) {
    return attr_perms.reduce((acc, perm) => {
        if (perm.describe) {
            acc.push({ attribute: perm.attribute_name });
        }
        return acc;
    }, []);
}

/**
 * Returns the schema metadata filtered based on permissions for the user role making the request
 *
 * @param describe_schema_object
 * @returns {Promise<{}|[]>}
 */
async function describeSchema(describe_schema_object) {
    let validation_msg = validator.schema_object(describe_schema_object);
    if (validation_msg) {
        throw validation_msg;
    }

    let schema_perms;

    if (describe_schema_object.hdb_user && !describe_schema_object.hdb_user.role.permission.super_user) {
        schema_perms = describe_schema_object.hdb_user.role.permission[describe_schema_object.schema];
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

        let schema = await p_search_search_by_hash(schema_search_obj);
        if (schema && schema.length < 1) {
            throw handleHDBError(new Error(), HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(describe_schema_object.schema),
                HTTP_STATUS_CODES.NOT_FOUND);
        } else {
            return {};
        }
    } else {
        let results = {};
        await Promise.all(
            tables.map(async (table) => {
                try {
                    let table_perms;
                    if (schema_perms && schema_perms.tables[table.name]) {
                        table_perms = schema_perms.tables[table.name];
                    }
                    if (hdb_utils.isEmpty(table_perms) || table_perms.describe) {
                        let data = await descTable({"schema": describe_schema_object.schema, "table": table.name}, table_perms ? table_perms.attribute_permissions : null);
                        if (data) {
                            results[data.name] = data;
                        }
                    }
                } catch (err) {
                    logger.error(`Error describing schema table '${describe_schema_object.schema}.${table}'`);
                    logger.error(err);
                }
            })
        );
        return results;
    }
}
