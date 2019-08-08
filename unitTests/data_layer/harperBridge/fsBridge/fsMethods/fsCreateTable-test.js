'use strict';

const test_utils = require('../../../../test_utils');
const fsCreateTable = require('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateTable');
const env = require('../../../../../utility/environment/environmentManager');
const uuidV4 = require('uuid/v4');
const fs = require('fs-extra');
const chai = require('chai');
const { expect } = chai;

const CREATE_TABLE_OBJ_TEST = {
    operation: 'create_table',
    schema: 'dogsrule',
    table: 'catsdrool',
    hash_attribute: 'id',
    };

const TABLE_SYSTEM_DATA_TEST = {
    name: CREATE_TABLE_OBJ_TEST.table,
    schema: CREATE_TABLE_OBJ_TEST.schema,
    id: uuidV4(),
    hash_attribute: CREATE_TABLE_OBJ_TEST.hash_attribute
};

let current_dir = `${process.cwd()}/unitTests/data_layer/harperBridge/fsBridge/fsMethods`;
const FULL_TABLE_PATH_TEST = `${current_dir}/schema/${CREATE_TABLE_OBJ_TEST.schema}/${CREATE_TABLE_OBJ_TEST.table}`;

describe('Test file system module fsCreateTable', () => {
    let root_orignial;

    before(() => {
        root_orignial = env.get('HDB_ROOT');
        env.setProperty('HDB_ROOT', current_dir);
    });

    after(() => {
        env.setProperty('HDB_ROOT', root_orignial);
        test_utils.cleanUpDirectories(`${current_dir}/schema`);
    });


    it('Test that createTable returns an error when the schema does not exist', async () => {
        let error;
        try {
            await fsCreateTable(TABLE_SYSTEM_DATA_TEST, CREATE_TABLE_OBJ_TEST);
        } catch(err) {
            error = err;
        }

        expect(error).to.be.an.instanceOf(Error);
        expect(error.message).to.equal('schema does not exist');
    });

    it('Test a table directory is created on the file system', async () => {
        try {
            // createTable expects schema dir to already exist so I am creating a temporary one.
            // Directory is removed after test
            await fs.mkdirp(`${current_dir}/schema/${CREATE_TABLE_OBJ_TEST.schema}`);
            await fsCreateTable(TABLE_SYSTEM_DATA_TEST, CREATE_TABLE_OBJ_TEST);
        } catch(err) {
            console.error(err);
        }

        let exists_on_fs = await fs.pathExists(FULL_TABLE_PATH_TEST);
        expect(exists_on_fs).to.be.true;
    });

    it('Test that createTable returns an error if the table already exists', async () => {
        let error;
        try {
            await fsCreateTable(TABLE_SYSTEM_DATA_TEST, CREATE_TABLE_OBJ_TEST);
        } catch(err) {
            error = err
        }

        expect(error).to.be.an.instanceOf(Error);
        expect(error.message).to.equal('table already exists');
    });
});
