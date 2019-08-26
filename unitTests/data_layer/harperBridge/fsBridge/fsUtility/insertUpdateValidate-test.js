'use strict';

const rewire = require('rewire');
const test_utils = require('../../../../test_utils');
const insertUpdateValidate = rewire('../../../../../data_layer/harperBridge/fsBridge/fsUtility/insertUpdateValidate');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const WRITE_OBJECT_TEST = {
    operation: "insert",
    schema: "system",
    table: "hdb_attribute",
    hash_attribute: "id",
    records: [
        {
            schema: "attrUnitTest",
            table: "dog",
            attribute: "another_attribute",
            id: "6d9bdde4-2a82-4f96-bc85-4515fda0be0b",
            schema_table: "attrUnitTest.dog"
        }
    ]
};

const SCEMA_TABLE_TEST = {
    hash_attribute: "id",
    name: "hdb_attribute",
    schema: "system",
    residence: [
        "*"
    ],
    attributes: [
        {
            attribute: "id"
        },
        {
            attribute: "schema"
        },
        {
            attribute: "table"
        },
        {
            attribute: "attribute"
        },
        {
            attribute: "schema_table"
        }
    ]
};

describe('Tests for fsUtility function', () => {
    let sandbox = sinon.createSandbox();
    let p_global_schema_stub = sandbox.stub().resolves(SCEMA_TABLE_TEST);

    before(() => {
        insertUpdateValidate.__set__('p_global_schema', p_global_schema_stub);
    });

    after(() => {
        sandbox.restore();
    });

    it('Test invalid update parameters defined error is thrown', async () => {
        let result = await test_utils.testError(insertUpdateValidate(null), 'invalid update parameters defined.');

        expect(result).to.be.true;
    });

    it('Test invalid schema specified error is thrown', async () => {
        let result = await test_utils.testError(insertUpdateValidate({schema: ''}), 'invalid schema specified.');

        expect(result).to.be.true;
    });
    
    it('Test invalid table specified error is thrown', async () => {
        let result = await test_utils.testError(insertUpdateValidate({schema: 'present', table: ''}), 'invalid table specified.');

        expect(result).to.be.true;
    });

    it('Test that insert validator throws schema must be alpha numeric error', async () => {
        let write_object_clone = test_utils.deepClone(WRITE_OBJECT_TEST);
        write_object_clone.table = '#$%';
        let result = await test_utils.testError(insertUpdateValidate(write_object_clone), 'Table schema must be alpha numeric');

        expect(result).to.be.true;
    });

    it('Test that valid hash must be provided error is thrown', async () => {
        let write_object_clone = test_utils.deepClone(WRITE_OBJECT_TEST);
        write_object_clone.operation = 'update';
        write_object_clone.records[0].id = '';
        let result = await test_utils.testError(insertUpdateValidate(write_object_clone), 'a valid hash attribute must be provided with update record');

        expect(result).to.be.true;
    });

    it('Test nominal operation and correct value returned', async () => {
        let result = await insertUpdateValidate(WRITE_OBJECT_TEST);
        let attributes_expected = [
            "schema",
            "table",
            "attribute",
            "id",
            "schema_table"
        ];
        let hashes_expected = ["6d9bdde4-2a82-4f96-bc85-4515fda0be0b"];

        expect(result.schema_table).to.eql(SCEMA_TABLE_TEST);
        expect(result.attributes).to.eql(attributes_expected);
        expect(result.hashes).to.eql(hashes_expected);
    });
});
