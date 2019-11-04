'use strict';

const rewire = require('rewire');
const test_utils = require('../../../../test_utils');
const fsCreateSchema = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateSchema');
const env = require('../../../../../utility/environment/environmentManager');
const fs = require('fs-extra');
const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;

const SCHEMA_CREATE_OBJ_TEST = {
    operation: 'create_schema',
    schema: 'dogs'
    };

const FULL_TABLE_PATH_TEST = `${__dirname}/schema/${SCHEMA_CREATE_OBJ_TEST.schema}`;
const ROOT_SCHEMA_DIR = `${__dirname}/schema/`;

async function setupTestSchemaDir() {
    try {
        await fs.mkdir(ROOT_SCHEMA_DIR);
    } catch(err) {
        console.error(err);
    }
}

describe('Test file system module fsCreateSchema', () => {
    let sandbox = sinon.createSandbox();
    let root_original;
    let create_records_stub = sandbox.stub();
+
    before(async () => {
        root_original = env.get('HDB_ROOT');
        fsCreateSchema.__set__('fsCreateRecords', create_records_stub);
        env.setProperty('HDB_ROOT', __dirname);
        await setupTestSchemaDir();
    });

    after(() => {
        env.setProperty('HDB_ROOT', root_original);
        test_utils.cleanUpDirectories(`${__dirname}/schema`);
        sandbox.restore();
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateSchema');
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
