'use strict';

const fs = require('fs-extra');
const env = require('../../../../utility/environment/environmentManager');
const terms = require('../../../../utility/hdbTerms');

module.exports = {
    createSchema
};

async function createSchema(schema_create_obj) {
    // This is here due to circular dependencies in insert
    const hdb_core_insert = require('../../../insert');

    let insert_object = {
        operation: 'insert',
        schema: 'system',
        table: 'hdb_schema',
        records: [
            {
                name: schema_create_obj.schema,
                createddate: '' + Date.now()
            }
        ]
    };

    try {
        await hdb_core_insert.insert(insert_object);
        await fs.mkdir(env.get('HDB_ROOT') + '/schema/' + schema_create_obj.schema, {mode: terms.HDB_FILE_PERMISSIONS});
    } catch(err) {
        if (err.errno === -17) {
            throw new Error('schema already exists');
        }

        throw err;
    }
}
