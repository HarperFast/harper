'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);
const rewire = require('rewire');
const processRows = rewire('../../../../../data_layer/harperBridge/fsBridge/fsUtility/processRows');

const DATA_WRAPPER_TEST = {
    written_hashes: [
        "dev"
    ],
    folders: [
        "/Users/david/hdb/schema/system/hdb_schema/name/dev",
    ],
    raw_data: [
        {
            path: "/Users/david/hdb/schema/system/hdb_schema/__hdb_hash/name/dev.hdb",
            value: "dev"
        },
    ],
    skipped: [],
    unlinks: []
};

const INSERT_OBJ_TEST = {
    operation: "insert",
    schema: "system",
    table: "hdb_schema",
    records: [
        {
            name: "dev",
            createddate: 1565028087315
        }
    ]};

const ATTRIBUTES_TEST = [
    "name",
    "createddate"
];

const SCHEMA_TABLE_TEST = {
    hash_attribute: "name",
    name: "hdb_schema",
    schema: "system",
    residence: [
        "*"
    ],
    attributes: [
        {
            attribute: "name"
        },
        {
            attribute: "createddate"
        }
    ]};

describe('Tests processRows module', () => {
    let sandbox = sinon.createSandbox();

    context('Test processRows function', () => {
        let data_write_processor_stub = sandbox.stub().resolves(DATA_WRAPPER_TEST);
        let data_write_processor_rw;
        let existing_rows = undefined;

        before(() => {
            data_write_processor_rw = processRows.__set__('dataWriteProcessor', data_write_processor_stub);
        });

        after(() => {
            sandbox.restore();
            data_write_processor_rw();
        });

        it('Test processRows calls WriteProcessorObject and dataWriteProcessor as expected', async () => {
            let result = await processRows(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST, existing_rows);

            expect(result).to.eql(DATA_WRAPPER_TEST);
            expect(data_write_processor_stub).to.have.been.calledOnce;
        });

        it('Test error is caught and thrown', async () => {
            data_write_processor_stub.throws(new Error('Data write error'));
            let test_error_response = await test_utils.testError(processRows(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST, existing_rows), 'Data write error');

            expect(test_error_response).to.be.true;
        });
    });
});
