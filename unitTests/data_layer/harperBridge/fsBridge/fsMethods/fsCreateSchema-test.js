'use strict';

const test_utils = require('../../../../test_utils');
const fsCreateSchema = require('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateSchema');
const hdb_core_insert = require('../../../../../data_layer/insert');
const env = require('../../../../../utility/environment/environmentManager');
const fs = require('fs-extra');
const chai = require('chai');
const { expect } = chai;

const SCHEMA_CREATE_OBJ_TEST = {
    operation: 'create_schema',
    schema: 'dogs'
    };
let current_dir = `${process.cwd()}/unitTests/data_layer/harperBridge/fsBridge/fsMethods`;
const FULL_TABLE_PATH_TEST = `${current_dir}/schema/${SCHEMA_CREATE_OBJ_TEST.schema}`;

describe('Test file system module fsCreateSchema', () => {
    let root_original;
+
    before(() => {
        root_original = env.get('HDB_ROOT');
        env.setProperty('HDB_ROOT', current_dir);
    });

    after(() => {
        env.setProperty('HDB_ROOT', root_original);
        test_utils.cleanUpDirectories(`${current_dir}/schema`);
    });
    
    it('Test a schema directory is created on the file system', async () => {
        await fsCreateSchema(SCHEMA_CREATE_OBJ_TEST);
        let exists_on_fs = await fs.pathExists(FULL_TABLE_PATH_TEST);

        expect(exists_on_fs).to.be.true;
    });

    it('Test that a schema already exists error is returned', async () => {
        let error;
        try {
            await fsCreateSchema(SCHEMA_CREATE_OBJ_TEST);
        } catch(err) {
            error = err;
        }

        expect(error).to.be.an.instanceOf(Error);
        expect(error.message).to.equal('schema already exists');
    });
});
