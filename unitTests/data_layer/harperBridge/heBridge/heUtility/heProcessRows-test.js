'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const heProcessRows = require('../../../../../data_layer/harperBridge/heBridge/heUtility/heProcessRows');
const hdb_terms = require('../../../../../utility/hdbTerms');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');

const SCHEMA_TABLE_TEST = {
    id: "c43762be-4943-4d10-81fb-1b857ed6cf3a",
    name: "dog",
    hash_attribute: "id",
    schema: "dev",
    attributes: []
};

const INSERT_OBJECT_TEST = {
    operation: "insert",
    schema: "dev",
    table: "dog",
    records: [
        {
            name: "Harper",
            breed: "Mutt",
            id: "8",
            age: 5
        },
        {
            name: "Penny",
            breed: "Mutt",
            id: "9",
            age: 5,
            height: 145
        },
        {
            name: "David",
            breed: "Mutt",
            id: "12"
        },
        {
            name: "Rob",
            breed: "Mutt",
            id: "10",
            age: 5,
            height: 145
        }
    ]
};

const ATTRIBUTES_TEST = [
    "name",
    "breed",
    "id",
    "age",
    "height"
];

const LONG_CHAR_TEST = "z2xFuWBiQgjAAAzgAK80e35FCuFzNHpicBWzsWZW055mFHwBxdU5yE5KlTQRzcZ04UlBTdhzDrVn1k1fuQCN9" +
    "faotQUlygf8Hv3E89f2v3KRzAX5FylEKwv4GJpSoZbXpgJ1mhmOjGUCAh3sipI5rVV0yvz6dbkXOw7xE5XlCHBRnc3T6BVyHIlUmFdlBowy" +
    "vAy7MT49mg6wn5yCqPEPFkcva2FNRYSNxljmu1XxN65mTKiTw2lvM0Yl2o0";

describe('Tests for Helium utility heProcessRows', () => {
    let insert_obj_single;
    let sandbox = sinon.createSandbox()

    before(() => {
        sandbox.stub(Date, 'now').returns('80443');
    });

    after(() => {
        sandbox.restore();
    });

    it('Test return obj is as expected for multiple uneven records', () => {
        let expected_result = {
            datastores: [ "dev/dog/name", "dev/dog/breed", "dev/dog/id", "dev/dog/age",
                "dev/dog/height",  "dev/dog/__createdtime__",  "dev/dog/__updatedtime__"],
            processed_rows: [
                [ "8", [ "Harper", "Mutt", "8", 5, null, "80443", "80443" ] ],
                [ "9", [ "Penny", "Mutt", "9", 5, 145, "80443", "80443" ] ],
                [ "12", [ "David", "Mutt", "12", null, null, "80443", "80443" ] ],
                [ "10", [ "Rob", "Mutt", "10", 5, 145, "80443", "80443" ] ]
            ]
        };
        let result = heProcessRows(INSERT_OBJECT_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST);

        expect(result).to.eql(expected_result);
    });

    it('Test return obj is as expected for a single entry multiple attributes', () => {
        insert_obj_single = test_utils.deepClone(INSERT_OBJECT_TEST);
        insert_obj_single.records = [
            {
                name: "Harper",
                breed: "Mutt",
                id: "8",
                age: 5
            },
        ];
        let expected_result = {
            datastores: [ "dev/dog/name", "dev/dog/breed", "dev/dog/id", "dev/dog/age", "dev/dog/height", "dev/dog/__createdtime__",  "dev/dog/__updatedtime__" ],
            processed_rows: [ [ "8", [ "Harper", "Mutt", "8", 5, null, "80443", "80443" ] ] ]
        };
        let result = heProcessRows(insert_obj_single, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST);

        expect(result).to.eql(expected_result);
    });

    it('Test return obj is as expected for a single datastore and row', () => {
        let expected_result = {
            datastores: [ "dev/dog/id", "dev/dog/__createdtime__",  "dev/dog/__updatedtime__" ],
            processed_rows: [ [ "8", [ "8", "80443", "80443" ] ] ]
        };
        let result = heProcessRows(insert_obj_single, ["id"], SCHEMA_TABLE_TEST);

        expect(result).to.eql(expected_result);
    });

    it('Test return obj is as expected for a single datastore and row', () => {
        let update_obj = test_utils.deepClone(insert_obj_single);
        update_obj.operation = 'update';
        let expected_result = {
            datastores: [ "dev/dog/id", "dev/dog/__createdtime__",  "dev/dog/__updatedtime__" ],
            processed_rows: [ [ "8", [ "8", null, "80443" ] ] ]
        };
        let result = heProcessRows(update_obj, ["id"], SCHEMA_TABLE_TEST);

        expect(result).to.eql(expected_result);
    });

    it('Test error is thrown if record has no hash', () => {
        let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);
        insert_obj.records = [
            {
                name: "Harper",
                breed: "Mutt",
                age: 5
            },
        ];
        let error;
        try {
            heProcessRows(insert_obj, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST);
        } catch(err) {
            error = err;
        }

        expect(error).to.be.an.instanceOf(Error);
        expect(error.message).to.equal('transaction aborted due to record(s) with no hash value, check log for more info');
    });

    it('Test error is thrown if hash is over max size', () => {
        let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);
        insert_obj.records = [
            {
                name: "Harper",
                breed: "Mutt",
                age: 5,
                id: LONG_CHAR_TEST
            },
        ];
        let error;
        try {
            heProcessRows(insert_obj, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST);
        } catch(err) {
            error = err;
        }

        expect(error).to.be.an.instanceOf(Error);
        expect(error.message).to.equal(`transaction aborted due to record(s) with a hash value that exceeds ${hdb_terms.INSERT_MODULE_ENUM.MAX_CHARACTER_SIZE} bytes, check log for more info`);
    });

    it('Test error is thrown if hash contains forward slash', () => {
        let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);
        insert_obj.records = [
            {
                name: "Harper",
                breed: "Mutt",
                age: 5,
                id: "slash/er"
            },
        ];
        let error;
        try {
            heProcessRows(insert_obj, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST);
        } catch(err) {
            error = err;
        }

        expect(error).to.be.an.instanceOf(Error);
        expect(error.message).to.equal('transaction aborted due to record(s) with a hash value that contains a forward slash, check log for more info');
    });

    it('Test error is thrown if attribute name is over max size', () => {
        let attributes = [...ATTRIBUTES_TEST];
        attributes[1] = LONG_CHAR_TEST;

        let error;
        try {
            heProcessRows(INSERT_OBJECT_TEST, attributes, SCHEMA_TABLE_TEST);
        } catch(err) {
            error = err;
        }

        expect(error).to.be.an.instanceOf(Error);
        expect(error.message).to.equal(`transaction aborted due to attribute name ${attributes[1]} being too long. Attribute names cannot be longer than ${hdb_terms.INSERT_MODULE_ENUM.MAX_CHARACTER_SIZE} bytes.`);
    });

    it('Test error is thrown if attribute name is null', () => {
        let attributes = [...ATTRIBUTES_TEST];
        attributes[1] = null;

        let error;
        try {
            heProcessRows(INSERT_OBJECT_TEST, attributes, SCHEMA_TABLE_TEST);
        } catch(err) {
            error = err;
        }

        expect(error).to.be.an.instanceOf(Error);
        expect(error.message).to.equal('transaction aborted due to record(s) with an attribute name that is null, undefined or empty string');
    });

    it('Test error is thrown if attribute name is undefined', () => {
        let attributes = [...ATTRIBUTES_TEST];
        attributes[1] = undefined;

        let error;
        try {
            heProcessRows(INSERT_OBJECT_TEST, attributes, SCHEMA_TABLE_TEST);
        } catch(err) {
            error = err;
        }

        expect(error).to.be.an.instanceOf(Error);
        expect(error.message).to.equal('transaction aborted due to record(s) with an attribute name that is null, undefined or empty string');
    });

    it('Test error is thrown if attribute name is empty', () => {
        let attributes = [...ATTRIBUTES_TEST];
        attributes[1] = "";

        let error;
        try {
            heProcessRows(INSERT_OBJECT_TEST, attributes, SCHEMA_TABLE_TEST);
        } catch(err) {
            error = err;
        }

        expect(error).to.be.an.instanceOf(Error);
        expect(error.message).to.equal('transaction aborted due to record(s) with an attribute name that is null, undefined or empty string');
    });
});
