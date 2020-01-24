"use strict";

const hdb_terms = require('../../../../utility/hdbTerms');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../../utility/lmdb/writeUtility');
const path = require('path');
const env_mgr = require('../../../../utility/environment/environmentManager');
const system_schema = require('../../../../json/systemSchema');
const schema_validator = require('../../../../validation/schema_validator');
const uuid = require('uuid');

if(!env_mgr.isInitialized()){
    env_mgr.initSync();
}

const BASE_SCHEMA_PATH = path.join(env_mgr.getHdbBasePath(), hdb_terms.SCHEMA_DIR_NAME);

const HDB_TABLE_INFO = system_schema.hdb_attribute;
let hdb_attribute_attributes = [];
for(let x = 0; x < HDB_TABLE_INFO.attributes.length; x++){
    hdb_attribute_attributes.push(HDB_TABLE_INFO.attributes[x].attribute);
}

let HDB_ATTRBUTE_ENV;

module.exports = lmdbCreateAttribute;

/**
 * First adds the attribute to the system attribute table, then creates the dbi.
 * @param create_attribute_obj
 * @returns {{skipped_hashes: *, update_hashes: *, message: string}}
 */
async function lmdbCreateAttribute(create_attribute_obj) {
    let validation_error = schema_validator.attribute_object(create_attribute_obj);
    if (validation_error) {
        throw validation_error;
    }

    let attributes_obj_array = [];
    //on initial creation of a table it will not exist in hdb_schema yet
    if(global.hdb_schema[create_attribute_obj.schema] && global.hdb_schema[create_attribute_obj.schema][create_attribute_obj.table]) {
        attributes_obj_array = global.hdb_schema[create_attribute_obj.schema][create_attribute_obj.table]['attributes'];
    }
    if(Array.isArray(attributes_obj_array) && attributes_obj_array.length > 0) {
        for (let attribute of attributes_obj_array) {
            if (attribute.attribute === create_attribute_obj.attribute) {
                throw new Error(`attribute '${attribute.attribute}' already exists in ${create_attribute_obj.schema}.${create_attribute_obj.table}`);
            }
        }
    }

    //insert the attribute meta_data into system.hdb_attribute
    let record = {
        schema: create_attribute_obj.schema,
        table: create_attribute_obj.table,
        attribute: create_attribute_obj.attribute,
        id: create_attribute_obj.id ? create_attribute_obj.id : uuid.v4(),
        schema_table: create_attribute_obj.schema + '.' + create_attribute_obj.table
    };

    try {
        //create dbi into the environment for this table
        let env = await environment_utility.openEnvironment(path.join(BASE_SCHEMA_PATH, create_attribute_obj.schema), create_attribute_obj.table);
        environment_utility.createDBI(env, create_attribute_obj.attribute, true);

        await getHDBAttributeEnvironment();

        write_utility.insertRecords(HDB_ATTRBUTE_ENV, HDB_TABLE_INFO.hash_attribute, hdb_attribute_attributes, [record]);
    } catch(e){
        throw e;
    }
}

async function getHDBAttributeEnvironment(){
    if(HDB_ATTRBUTE_ENV === undefined){
        HDB_ATTRBUTE_ENV = await environment_utility.openEnvironment(path.join(BASE_SCHEMA_PATH, hdb_terms.SYSTEM_SCHEMA_NAME), hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME);
    }
}