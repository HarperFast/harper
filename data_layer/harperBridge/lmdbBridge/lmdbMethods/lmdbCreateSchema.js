'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const lmdb_create_records = require('./lmdbCreateRecords');
const fs = require('fs-extra');
const path = require('path');
const terms = require('../../../../utility/hdbTerms');
const env = require('../../../../utility/environment/environmentManager');

if(!env.isInitialized()){
    env.initSync();
}

const BASE_SCHEMA_PATH = path.join(env.getHdbBasePath(), terms.SCHEMA_DIR_NAME);

module.exports = lmdbCreateSchema;

/**
 * creates the meta data for the schema
 * @param create_schema_obj
 */
async function lmdbCreateSchema(create_schema_obj) {
    let insert_object = {
        operation: hdb_terms.OPERATIONS_ENUM.INSERT,
        schema: hdb_terms.SYSTEM_SCHEMA_NAME,
        table: hdb_terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
        records: [
            {
                name: create_schema_obj.schema,
                createddate: '' + Date.now()
            }
        ]
    };

    try {
        let results = await lmdb_create_records(insert_object);
        if(results.written_hashes.length > 0){
            await fs.mkdirp(path.join(BASE_SCHEMA_PATH, create_schema_obj.schema));
        }
    } catch(err) {
        throw err;
    }
}