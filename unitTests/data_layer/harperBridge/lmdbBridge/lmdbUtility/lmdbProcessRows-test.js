'use strict';

const rewire = require('rewire');
const lmdb_process_rows = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbProcessRows');
const validate_hash_function = lmdb_process_rows.__get__('validateHash');
const validate_attribute_function = lmdb_process_rows.__get__('validateAttribute');
const process_rows_function = lmdb_process_rows.__get__('processRows');
const hdb_terms = require('../../../../../utility/hdbTerms');
const uuid = require('uuid');
const sinon = require('sinon');
const MOCK_UUID_VALUE = 'cool-uuid-value';

const sandbox = sinon.createSandbox();

const { TEST_INSERT_OPS_ERROR_MSGS } = require('../../../../commonTestErrors');
const test_utils = require('../../../../test_utils');
const assert = require('assert');

const HASH_ATTRIBUTE_NAME = 'id';
const RECORD = {
    id:1,
    name: 'Kyle',
    age: 46
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

const NO_HASH_VALUE_ERROR = test_utils.generateHDBError(TEST_INSERT_OPS_ERROR_MSGS.RECORD_MISSING_HASH_ERR, 400);
const EMPTY_ATTRIBUTE_NAME_ERROR = test_utils.generateHDBError(TEST_INSERT_OPS_ERROR_MSGS.ATTR_NAME_NULLISH_ERR, 400);

const LONG_CHAR_TEST = "z2xFuWBiQgjAAAzgAK80e35FCuFzNHpicBWzsWZW055mFHwBxdU5yE5KlTQRzcZ04UlBTdhzDrVn1k1fuQCN9" +
    "faotQUlygf8Hv3E89f2v3KRzAX5FylEKwv4GJpSoZbXpgJ1mhmOjGUCAh3sipI5rVV0yvz6dbkXOw7xE5XlCHBRnc3T6BVyHIlUmFdlBowy" +
    "vAy7MT49mg6wn5yCqPEPFkcva2FNRYSNxljmu1XxN65mTKiTw2lvM0Yl2o0";

describe('Test lmdbProcessRows module', ()=>{
    let uuid_stub;

    before(()=>{
        uuid_stub = sandbox.stub(uuid, 'v4').returns(MOCK_UUID_VALUE);
    });

    after(()=>{
        uuid_stub.restore();
    });
    describe('Test validateHash function', ()=>{
        it('test record with no hash attribute value entry when updating', ()=>{
            let test_record = test_utils.deepClone(RECORD);
            delete test_record[HASH_ATTRIBUTE_NAME];
            test_utils.assertErrorSync(validate_hash_function, [test_record, HASH_ATTRIBUTE_NAME, hdb_terms.OPERATIONS_ENUM.UPDATE],
                NO_HASH_VALUE_ERROR, 'test no id attribute');

            let test_record2 = test_utils.deepClone(RECORD);
            test_record2[HASH_ATTRIBUTE_NAME] = null;
            test_utils.assertErrorSync(validate_hash_function, [test_record2, HASH_ATTRIBUTE_NAME, hdb_terms.OPERATIONS_ENUM.UPDATE],
                NO_HASH_VALUE_ERROR, 'test null id value');

            let test_record3 = test_utils.deepClone(RECORD);
            test_record3[HASH_ATTRIBUTE_NAME] = undefined;
            test_utils.assertErrorSync(validate_hash_function, [test_record3, HASH_ATTRIBUTE_NAME, hdb_terms.OPERATIONS_ENUM.UPDATE],
                NO_HASH_VALUE_ERROR, 'test undefined id value');

            let test_record4 = test_utils.deepClone(RECORD);
            test_record4[HASH_ATTRIBUTE_NAME] = '';
            test_utils.assertErrorSync(validate_hash_function, [test_record4, HASH_ATTRIBUTE_NAME, hdb_terms.OPERATIONS_ENUM.UPDATE],
                NO_HASH_VALUE_ERROR, 'test empty string id value');
        });

        it('test record with no hash attribute entry when inserting', ()=>{
            let test_record = test_utils.deepClone(RECORD);
            delete test_record[HASH_ATTRIBUTE_NAME];
            test_utils.assertErrorSync(validate_hash_function, [test_record, HASH_ATTRIBUTE_NAME, hdb_terms.OPERATIONS_ENUM.INSERT],
                undefined, 'test no id attribute');

            assert(test_record.hasOwnProperty(HASH_ATTRIBUTE_NAME) === true );
            assert.deepStrictEqual(test_record[HASH_ATTRIBUTE_NAME], MOCK_UUID_VALUE);

            let test_record2 = test_utils.deepClone(RECORD);
            test_record2[HASH_ATTRIBUTE_NAME] = null;
            test_utils.assertErrorSync(validate_hash_function, [test_record2, HASH_ATTRIBUTE_NAME, hdb_terms.OPERATIONS_ENUM.INSERT],
                undefined, 'test null id value');

            assert(test_record2.hasOwnProperty(HASH_ATTRIBUTE_NAME) === true );
            assert.deepStrictEqual(test_record2[HASH_ATTRIBUTE_NAME], MOCK_UUID_VALUE);

            let test_record3 = test_utils.deepClone(RECORD);
            test_record3[HASH_ATTRIBUTE_NAME] = undefined;
            test_utils.assertErrorSync(validate_hash_function, [test_record3, HASH_ATTRIBUTE_NAME, hdb_terms.OPERATIONS_ENUM.INSERT],
                undefined, 'test undefined id value');

            assert(test_record3.hasOwnProperty(HASH_ATTRIBUTE_NAME) === true );
            assert.deepStrictEqual(test_record3[HASH_ATTRIBUTE_NAME], MOCK_UUID_VALUE);

            let test_record4 = test_utils.deepClone(RECORD);
            test_record4[HASH_ATTRIBUTE_NAME] = undefined;
            test_utils.assertErrorSync(validate_hash_function, [test_record4, HASH_ATTRIBUTE_NAME, hdb_terms.OPERATIONS_ENUM.INSERT],
                undefined, 'test empty string id value');

            assert(test_record4.hasOwnProperty(HASH_ATTRIBUTE_NAME) === true );
            assert.deepStrictEqual(test_record4[HASH_ATTRIBUTE_NAME], MOCK_UUID_VALUE);
        });

        it('Test error is thrown if hash is over max size', () => {
            let test_record = test_utils.deepClone(RECORD);
            test_record[HASH_ATTRIBUTE_NAME] = LONG_CHAR_TEST;

            test_utils.assertErrorSync(validate_hash_function, [test_record, HASH_ATTRIBUTE_NAME, hdb_terms.OPERATIONS_ENUM.INSERT],
                test_utils.generateHDBError(TEST_INSERT_OPS_ERROR_MSGS.HASH_VAL_LENGTH_ERR, 400),
                'test id value too long');
        });

        it('Test error is thrown if hash has slash "/"', () => {
            let test_record = test_utils.deepClone(RECORD);
            test_record[HASH_ATTRIBUTE_NAME] = "slash/er";

            test_utils.assertErrorSync(validate_hash_function, [test_record, HASH_ATTRIBUTE_NAME, hdb_terms.OPERATIONS_ENUM.INSERT],
                test_utils.generateHDBError(TEST_INSERT_OPS_ERROR_MSGS.INVALID_FORWARD_SLASH_IN_HASH_ERR, 400),
                'test id value with slash "/"');
        });

        it('Test happy path', () => {
            let test_record = test_utils.deepClone(RECORD);

            test_utils.assertErrorSync(validate_hash_function, [test_record, HASH_ATTRIBUTE_NAME, hdb_terms.OPERATIONS_ENUM.INSERT],
                undefined, 'all good with insert');

            let test_record2 = test_utils.deepClone(RECORD);
            test_record2[HASH_ATTRIBUTE_NAME] = 'coolid';
            test_utils.assertErrorSync(validate_hash_function, [test_record2, HASH_ATTRIBUTE_NAME, hdb_terms.OPERATIONS_ENUM.INSERT],
                undefined, 'all good with insert');
        });
    });

    describe("test validateAttribute function", ()=>{
        it("test attribute name too long", ()=>{
            test_utils.assertErrorSync(validate_attribute_function, [LONG_CHAR_TEST],
                test_utils.generateHDBError(TEST_INSERT_OPS_ERROR_MSGS.ATTR_NAME_LENGTH_ERR(LONG_CHAR_TEST), 400),
                'attribute name too long');
        });

        it("test empty attribute names", ()=>{
            test_utils.assertErrorSync(validate_attribute_function, [], EMPTY_ATTRIBUTE_NAME_ERROR);
            test_utils.assertErrorSync(validate_attribute_function, [null], EMPTY_ATTRIBUTE_NAME_ERROR);
            test_utils.assertErrorSync(validate_attribute_function, [undefined], EMPTY_ATTRIBUTE_NAME_ERROR);
            test_utils.assertErrorSync(validate_attribute_function, [''], EMPTY_ATTRIBUTE_NAME_ERROR);
        });

        it("test happy path", ()=>{
            test_utils.assertErrorSync(validate_attribute_function, [HASH_ATTRIBUTE_NAME], undefined);
        });
    });

    describe('Test processRows', ()=>{
        it('test happy path', ()=>{
            let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);

            test_utils.assertErrorSync(process_rows_function, [insert_obj, ATTRIBUTES_TEST, HASH_ATTRIBUTE_NAME], undefined);
        });
    });
});
