'use strict';

const fs = require('fs-extra');
const create_records = require('./fsCreateRecords');

module.exports = {
    createSchema
};

async function createSchema(schema_create_obj, permissions, hdb_root) {

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
        await create_records.fsCreateRecords(insert_object); // TODO: Need to build this
        await fs.mkdir(`${hdb_root}/schema/${schema_create_obj.schema}`, {mode: permissions});
    } catch(err) {
        if (err.errno === -17) {
            throw new Error('schema already exists');
        }

        throw err;
    }
}
