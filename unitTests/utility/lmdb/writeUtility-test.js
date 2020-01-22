"use strict";

const rewire = require('rewire');
const write_utility = rewire('../../../utility/lmdb/writeUtility');
const environment_utility = require('../../../utility/lmdb/environmentUtility');
const rw_write_validator = write_utility.__get__('validateWrite');
const search_util = require('../../../utility/lmdb/searchUtility');
const assert = require('assert');
const path = require('path');
const test_utils = require('../../test_utils');
const fs = require('fs-extra');
const LMDB_TEST_ERRORS = require('../../commonTestErrors').LMDB_ERRORS_ENUM;
const sinon = require('sinon');

const TIMESTAMP = Date.now();

const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'lmdbTest');
const TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';
const ALL_ATTRIBUTES = ['id', 'name', 'age', '__createdtime__', '__updatedtime__'];
const ONE_RECORD_ARRAY = [
    {id:1, name:'Kyle', age:'46'}
];

const ONE_RECORD_ARRAY_EXPECTED = [
    {__createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP,id:1, name:'Kyle', age:'46'}
];

const UPDATE_ONE_RECORD_ARRAY = [
    {id:1, name:'Kyle Bernhardy', age:'46', height:'6\'1"'}
];

const UPDATE_ONE_RECORD_ARRAY_EXPECTED = [
    {__createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP, id:1, name:'Kyle Bernhardy', age:'46', height:'6\'1"'}
];

const sandbox = sinon.createSandbox();

const UPDATE_ONE_FAKE_RECORD = {id:111, name:'FAKE ROW', age:'0'};

describe("Test writeUtility module", ()=>{
    let date_stub;
    before(()=>{
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
    });

    after(()=>{
        date_stub.restore();
    });

    describe("Test validateInsert function", ()=>{
        let env;
        before(async ()=>{
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        });

        after(async ()=>{
            sandbox.restore();
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test function", ()=>{
            test_utils.assertErrorSync(rw_write_validator, [], LMDB_TEST_ERRORS.ENV_REQUIRED, "pass no args");
            test_utils.assertErrorSync(rw_write_validator, ['test'], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, "pass invalid env");
            test_utils.assertErrorSync(rw_write_validator, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, "pass valid env, no other args");
            test_utils.assertErrorSync(rw_write_validator, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_REQUIRED, "pass valid env hash_attribute");
            test_utils.assertErrorSync(rw_write_validator, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY,
                "pass valid env hash_attribute, invalid all_attributes");
            test_utils.assertErrorSync(rw_write_validator, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], LMDB_TEST_ERRORS.RECORDS_REQUIRED,
                "pass valid env hash_attribute all_attributes");
            test_utils.assertErrorSync(rw_write_validator, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY[0]], LMDB_TEST_ERRORS.RECORDS_MUST_BE_ARRAY,
                "pass valid env hash_attribute all_attributes, invalid records");
            test_utils.assertErrorSync(rw_write_validator, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, []], undefined,
                "pass valid env hash_attribute all_attributes records");
        });
    });

    describe("Test insertRecords function", ()=>{
        before(()=>{
            date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
        });
        let env;
        beforeEach(async ()=>{

            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false);
        });

        afterEach(async ()=>{
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", ()=>{
            test_utils.assertErrorSync(write_utility.insertRecords, [], LMDB_TEST_ERRORS.ENV_REQUIRED, "pass no args");
            test_utils.assertErrorSync(write_utility.insertRecords, ['test'], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, "pass invalid env");
            test_utils.assertErrorSync(write_utility.insertRecords, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, "pass valid env, no other args");
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_REQUIRED, "pass valid env hash_attribute");
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY,
                "pass valid env hash_attribute, invalid all_attributes");
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], LMDB_TEST_ERRORS.RECORDS_REQUIRED,
                "pass valid env hash_attribute all_attributes");
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY[0]], LMDB_TEST_ERRORS.RECORDS_MUST_BE_ARRAY,
                "pass valid env hash_attribute all_attributes, invalid records");
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, []], undefined,
                "pass valid env hash_attribute all_attributes records");
        });

        it("test insert one row", ()=>{
            //test no records
            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            assert.deepStrictEqual(records, []);

            let result = test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY], undefined,
                "pass valid env hash_attribute all_attributes records");

            assert.deepStrictEqual(result, {written_hashes: [1], skipped_hashes: []});

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            assert.deepStrictEqual(records, ONE_RECORD_ARRAY_EXPECTED);
        });

        //TODO validate existing records being inserted are added to skipped
        it("test insert one row that already exists", ()=>{
            let result = test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY], undefined,
                "pass valid env hash_attribute all_attributes records");

            assert.deepStrictEqual(result, {written_hashes: [1], skipped_hashes: []});

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            assert.deepStrictEqual(records, ONE_RECORD_ARRAY_EXPECTED);

            result = test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY], undefined,
                "pass valid env hash_attribute all_attributes records");

            assert.deepStrictEqual(result, {written_hashes: [], skipped_hashes: [1]});
        });

        //TODO validate records exist in all indices
    });

    describe("Test updateRecords function", ()=>{
        let env;
        beforeEach(async ()=>{
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false);
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY);
        });

        afterEach(async ()=>{
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", ()=>{
            test_utils.assertErrorSync(write_utility.updateRecords, [], LMDB_TEST_ERRORS.ENV_REQUIRED, "pass no args");
            test_utils.assertErrorSync(write_utility.updateRecords, ['test'], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, "pass invalid env");
            test_utils.assertErrorSync(write_utility.updateRecords, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, "pass valid env, no other args");
            test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_REQUIRED, "pass valid env hash_attribute");
            test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY,
                "pass valid env hash_attribute, invalid all_attributes");
            test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], LMDB_TEST_ERRORS.RECORDS_REQUIRED,
                "pass valid env hash_attribute all_attributes");
            test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY[0]], LMDB_TEST_ERRORS.RECORDS_MUST_BE_ARRAY,
                "pass valid env hash_attribute all_attributes, invalid records");
            test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, []], undefined,
                "pass valid env hash_attribute all_attributes records");
        });

        it("test update one existing row", ()=>{
            let all_attributes_for_update = ['__createdtime__', '__updatedtime__','age', 'height', 'id', 'name'];

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            assert.deepStrictEqual(records, ONE_RECORD_ARRAY_EXPECTED);

            let results = test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, UPDATE_ONE_RECORD_ARRAY], undefined);
            assert.deepStrictEqual(results, {written_hashes:[1], skipped_hashes:[]});

            let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
            assert.deepStrictEqual(all_dbis, all_attributes_for_update);

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, all_dbis], undefined);
            assert.deepStrictEqual(records,UPDATE_ONE_RECORD_ARRAY_EXPECTED);
        });

        it("test update one existing row & one non-existing row", ()=>{
            let all_attributes_for_update = ['__createdtime__', '__updatedtime__','age', 'height', 'id', 'name'];

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            assert.deepStrictEqual(records, ONE_RECORD_ARRAY);

            let results = test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, UPDATE_ONE_RECORD_ARRAY.concat(UPDATE_ONE_FAKE_RECORD)], undefined);
            assert.deepStrictEqual(results, {written_hashes:[1], skipped_hashes:[111]});

            let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
            assert.deepStrictEqual(all_dbis, all_attributes_for_update);

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, all_dbis], undefined);
            assert.deepStrictEqual(records,UPDATE_ONE_RECORD_ARRAY_EXPECTED);
        });
    });
});