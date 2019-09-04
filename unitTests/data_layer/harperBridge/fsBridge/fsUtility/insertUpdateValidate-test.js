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

describe('Tests for fsUtility function insertUpdateValidate', () => {
    let sandbox = sinon.createSandbox();

    before(() => {
        global.hdb_schema = {
            [SCEMA_TABLE_TEST.schema]: {
                [SCEMA_TABLE_TEST.name]: {
                    attributes: SCEMA_TABLE_TEST.attributes,
                    hash_attribute: SCEMA_TABLE_TEST.hash_attribute,
                    residence: SCEMA_TABLE_TEST.residence,
                    schema: SCEMA_TABLE_TEST.schema,
                    name: SCEMA_TABLE_TEST.name
                }
            }
        };
    });

    after(() => {
        delete global.hdb_schema[SCEMA_TABLE_TEST.schema];
        sandbox.restore();
    });

    it('Test invalid update parameters defined error is thrown',() => {
        let error;
        try {
            insertUpdateValidate(null);
        } catch(err) {
            error = err;
        }

        expect(error.message).to.equal('invalid update parameters defined.');
        expect(error).to.be.instanceOf(Error);
    });

    it('Test invalid schema specified error is thrown',() => {
        let error;
        try {
            insertUpdateValidate({schema: ''});
        } catch(err) {
            error = err;
        }

        expect(error.message).to.equal('invalid schema specified.');
        expect(error).to.be.instanceOf(Error);
    });
    
    it('Test invalid table specified error is thrown',() => {
        let error;
        try {
            insertUpdateValidate({schema: 'present', table: ''});
        } catch(err) {
            error = err;
        }

        expect(error.message).to.equal('invalid table specified.');
        expect(error).to.be.instanceOf(Error);
    });

    it('Test that insert validator throws schema must be alpha numeric error',() => {
        let write_object_clone = test_utils.deepClone(WRITE_OBJECT_TEST);
        write_object_clone.table = '#$%';
        let error;
        try {
            insertUpdateValidate(write_object_clone);
        } catch(err) {
            error = err;
        }

        expect(error.message).to.equal('Table schema must be alpha numeric');
        expect(error).to.be.instanceOf(Error);
    });

    it('Test that valid hash must be provided error is thrown',() => {
        let write_object_clone = test_utils.deepClone(WRITE_OBJECT_TEST);
        write_object_clone.operation = 'update';
        write_object_clone.records[0].id = '';
        let error;
        try {
            insertUpdateValidate(write_object_clone);
        } catch(err) {
            error = err;
        }

        expect(error.message).to.equal('a valid hash attribute must be provided with update record');
        expect(error).to.be.instanceOf(Error);
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
