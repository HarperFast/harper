"use strict";

const write_utility = require('../../../utility/lmdb/writeUtility');
const environment_utility = require('../../../utility/lmdb/environmentUtility');
const rewire = require('rewire');
const rw_write_util = rewire('../../../utility/lmdb/writeUtility');
const rw_insert_validator = rw_write_util.__get__('validateInsert');

const path = require('path');
const test_utils = require('../../test_utils');
const fs = require('fs-extra');
const LMDB_TEST_ERRORS = require('../../commonTestErrors').LMDB_ERRORS_ENUM;

const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'lmdbTest');
const TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';
const ALL_ATTRIBUTES = ['id', 'name', 'age'];
const ONE_RECORD_ARRAY = [
    {id:1, name:'Kyle', age:'46'}
];

describe("Test writeUtility module", ()=>{
    describe("Test validateInsert function", ()=>{
        let env;
        before(async ()=>{
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        });

        after(async ()=>{
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("pass no args", ()=>{
            test_utils.assertErrorSync(rw_insert_validator, [], LMDB_TEST_ERRORS.ENV_REQUIRED);
        });

        it("pass invalid env", ()=>{
            test_utils.assertErrorSync(rw_insert_validator, ['test'], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT);
        });

        it("pass valid env, no other args", ()=>{
            test_utils.assertErrorSync(rw_insert_validator, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED);
        });

        it("pass valid env hash_attribute", ()=>{
            test_utils.assertErrorSync(rw_insert_validator, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_REQUIRED);
        });

        it("pass valid env hash_attribute, invalid all_attributes", ()=>{
            test_utils.assertErrorSync(rw_insert_validator, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY);
        });

        it("pass valid env hash_attribute all_attributes", ()=>{
            test_utils.assertErrorSync(rw_insert_validator, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], LMDB_TEST_ERRORS.RECORDS_REQUIRED);
        });

        it("pass valid env hash_attribute all_attributes, invalid records", ()=>{
            test_utils.assertErrorSync(rw_insert_validator, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY[0]], LMDB_TEST_ERRORS.RECORDS_MUST_BE_ARRAY);
        });

        it("pass valid env hash_attribute all_attributes records", ()=>{
            test_utils.assertErrorSync(rw_insert_validator, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY], undefined);
        });
    });

    describe("Test insertRecords function", ()=>{
        let env;
        before(async ()=>{
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
        });

        after(async ()=>{
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("pass no args", ()=>{
            test_utils.assertErrorSync(write_utility.insertRecords, [], LMDB_TEST_ERRORS.ENV_REQUIRED);
        });

        it("pass invalid env", ()=>{
            test_utils.assertErrorSync(write_utility.insertRecords, ['test'], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT);
        });

        it("pass valid env, no other args", ()=>{
            test_utils.assertErrorSync(write_utility.insertRecords, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED);
        });

        it("pass valid env hash_attribute", ()=>{
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_REQUIRED);
        });

        it("pass valid env hash_attribute, invalid all_attributes", ()=>{
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY);
        });

        it("pass valid env hash_attribute all_attributes", ()=>{
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], LMDB_TEST_ERRORS.RECORDS_REQUIRED);
        });

        it("pass valid env hash_attribute all_attributes, invalid records", ()=>{
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY[0]], LMDB_TEST_ERRORS.RECORDS_MUST_BE_ARRAY);
        });

        it("pass valid env hash_attribute all_attributes records", ()=>{
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY], undefined);
        });

        //TODO validate records exist in all indices
    });
});