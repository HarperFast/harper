"use strict";

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const create_schema = require('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateSchema');
const create_records = require('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateRecords');
const fs = require('fs-extra');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const SCHEMA_CREATE_OBJECT_TEST = {operation: 'create_schema', schema: 'dogs'};
const HDB_FILE_PERMISSIONS_TEST = 0o700;
const SCHEMA_ROOT_TEST = '/hdb/schema';

describe('Test file system module fsCreateSchema', () => {
    let sandbox = sinon.createSandbox();
    let create_records_stub;
    let fs_mkdir_stub;

    before(() => {
        create_records_stub = sandbox.stub(create_records, 'fsCreateRecords');
        fs_mkdir_stub = sandbox.stub(fs, 'mkdir');
    });

    after(() => {
        sandbox.restore();
    });

    it('test createRecords and fs.mkdir are called as expected', async () => {
        try {
            await create_schema.createSchema(SCHEMA_CREATE_OBJECT_TEST, HDB_FILE_PERMISSIONS_TEST, SCHEMA_ROOT_TEST);

            expect(create_records_stub).to.have.been.calledOnce;
            expect(fs_mkdir_stub).to.have.been.calledWith(`${SCHEMA_ROOT_TEST}/schema/${SCHEMA_CREATE_OBJECT_TEST.schema}`, {mode: HDB_FILE_PERMISSIONS_TEST});
        } catch(err) {
            console.error(err);
        }
    });

    it('test error from fs.mkdir is caught', async () => {
        let error;
        fs_mkdir_stub.throws(new Error('Error creating directory'));

        try {
            await create_schema.createSchema(SCHEMA_CREATE_OBJECT_TEST, HDB_FILE_PERMISSIONS_TEST, SCHEMA_ROOT_TEST);
        } catch(err) {
            error = err;
        }

        expect(error.message).to.equal('Error creating directory');
    });
});
