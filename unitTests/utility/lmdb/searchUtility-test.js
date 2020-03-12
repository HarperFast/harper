'use strict';

const rewire = require('rewire');
const search_util = rewire('../../../utility/lmdb/searchUtility');
const fs = require('fs-extra');
const environment_utility = rewire('../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../utility/lmdb/writeUtility');
const lmdb_terms = require('../../../utility/lmdb/terms');
const test_utils = require('../../test_utils');
const path = require('path');
const assert = require('assert');
const test_data = require('../../testData');
const LMDB_TEST_ERRORS = require('../../commonTestErrors').LMDB_ERRORS_ENUM;
const set_whole_row_flag = search_util.__get__('setGetWholeRowFlag');

const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'lmdbTest');
const TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';
const SOME_ATTRIBUTES = ['id', 'name', 'age'];
const All_ATTRIBUTES = ['id', 'name', 'age', 'city'];

const MULTI_RECORD_ARRAY = [
    {id:1, name:'Kyle', age:46, city:'Denver'},
    {id:2, name:'Jerry', age:32},
    {id:3, name: 'Hank', age: 57},
    {id:4, name:'Joy', age: 44, city:'Denver'}
];


const MULTI_RECORD_ARRAY2 = [
    {id:1, name:'Kyle', age:46, city:'Denver'},
    {id:2, name:'Jerry', age:32},
    {id:3, name: 'Hank', age: 57},
    {id:4, name:'Joy', age: 44, city:'Denver'},
    {id:5, name:'Fran', age: 44, city:'Denvertown'},
];

describe('Test searchUtility module', ()=>{
    let rw_env_util;
    before(()=> {
        rw_env_util = environment_utility.__set__('MAP_SIZE', 10 * 1024 * 1024 * 1024);
    });

    after(()=> {
        rw_env_util();
    });

    describe('test searchByHash function', ()=>{
        let env;
        before(async ()=>{
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false);
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(SOME_ATTRIBUTES), MULTI_RECORD_ARRAY);
        });

        after(async ()=>{
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", ()=>{
            test_utils.assertErrorSync(search_util.searchByHash, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.searchByHash, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.searchByHash, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_REQUIRED, 'no fetch_attributes');
            test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_MUST_BE_ARRAY, 'invalid fetch_attributes');
            test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES], LMDB_TEST_ERRORS.ID_REQUIRED, 'no id');
            test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, MULTI_RECORD_ARRAY[0][HASH_ATTRIBUTE_NAME]],
                undefined, 'all arguments sent');
        });

        it("test select all attributes", ()=>{
            let record = test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, "3"],
                undefined, 'all arguments sent');

            assert.deepStrictEqual(record, test_utils.assignObjecttoNullObject({"age": 57, "id": 3, "name": "Hank"}));
        });

        it("test select record no exist", ()=>{
            let record = test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, "33"],
                undefined, 'all arguments sent');

            assert.deepStrictEqual(record, null);
        });

        it("test select record only id & name", ()=>{
            let record = test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, ["id", "name"], "2"],
                undefined, 'all arguments sent');

            assert.deepStrictEqual(record, test_utils.assignObjecttoNullObject({id:2, name:"Jerry"}));
        });

        it("test select record only id & name and non-exsitent attribute", ()=>{
            let record = test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, ["id", "name", "dob"], "2"],
                undefined, 'all arguments sent');

            assert.deepStrictEqual(record, test_utils.assignObjecttoNullObject({id:2, name:"Jerry", dob:undefined}));
        });
    });

    describe("Test batchSearchByHash", ()=>{
        let env;
        before(async ()=>{
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(SOME_ATTRIBUTES), MULTI_RECORD_ARRAY);
        });

        after(async ()=>{
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", ()=>{
            test_utils.assertErrorSync(search_util.batchSearchByHash, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_REQUIRED, 'no fetch_attributes');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_MUST_BE_ARRAY, 'invalid fetch_attributes');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES], LMDB_TEST_ERRORS.IDS_REQUIRED, 'no id');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, "1"],
                LMDB_TEST_ERRORS.IDS_MUST_BE_ARRAY, 'invalid ids');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, ["1", "3", "2"]],
                undefined, 'all correct arguments');
        });

        it("test fetch single record", ()=>{
            let expected = {"1":{id:1, name:'Kyle', age:46}};
            let row = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, ["1"]],
                undefined, 'fetch single row');

            assert.deepEqual(row, expected);
        });

        it("test fetch multiple records", ()=>{
            let expected = {"1":{id:1, name:'Kyle', age:46},
                "4":{id:4, name:'Joy', age: 44},
                "2":{id:2, name:'Jerry', age:32}};
            let row = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, ["1", "4", "2"]],
                undefined, 'fetch multi rows');

            assert.deepEqual(row, expected);
        });

        it("test fetch multiple records some don't exist", ()=>{
            let expected = {"1":{id:1, name:'Kyle', age:46},
                "4": {id:4, name:'Joy', age: 44},
                "2":{id:2, name:'Jerry', age:32}};

            let row = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, ["1","fake", "4", "55", "2"]],
                undefined, 'fetch single row');

            assert.deepEqual(row, expected);
        });
    });

    describe("Test batchSearchByHashToMap", ()=>{
        let env;
        before(async ()=>{
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(SOME_ATTRIBUTES), MULTI_RECORD_ARRAY);
        });

        after(async ()=>{
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", ()=>{
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_REQUIRED, 'no fetch_attributes');
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_MUST_BE_ARRAY, 'invalid fetch_attributes');
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES], LMDB_TEST_ERRORS.IDS_REQUIRED, 'no id');
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, "1"],
                LMDB_TEST_ERRORS.IDS_MUST_BE_ARRAY, 'invalid ids');
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, ["1", "3", "2"]],
                undefined, 'all correct arguments');
        });

        it("test fetch single record", ()=>{
            let row = test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, ["1"]],
                undefined, 'fetch single row');

            assert.deepStrictEqual(row, test_utils.assignObjecttoNullObject({1: test_utils.assignObjecttoNullObject({id:1, name:'Kyle', age:46})}));
        });

        it("test fetch multiple records", ()=>{
            let row = test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, ["1", "4", "2"]],
                undefined, 'fetch multi rows');

            let expected = test_utils.assignObjecttoNullObject({1: test_utils.assignObjecttoNullObject({id:1, name:'Kyle', age:46}),
                2: test_utils.assignObjecttoNullObject({id:2, name:'Jerry', age:32}),
                4: test_utils.assignObjecttoNullObject({id:4, name:'Joy', age: 44})
            });

            assert.deepStrictEqual(row, expected);
        });

        it("test fetch multiple records some don't exist", ()=>{
            let row = test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, ["1","fake", "4", "55", "2"]],
                undefined, 'fetch single row');
            let expected = test_utils.assignObjecttoNullObject( {1: test_utils.assignObjecttoNullObject( {id:1, name:'Kyle', age:46}),
                2: test_utils.assignObjecttoNullObject( {id:2, name:'Jerry', age:32}),
                4: test_utils.assignObjecttoNullObject( {id:4, name:'Joy', age: 44})
            });
            assert.deepStrictEqual(row, expected);
        });
    });

    describe("Test checkHashExists", ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(SOME_ATTRIBUTES), MULTI_RECORD_ARRAY);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.checkHashExists, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.checkHashExists, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.checkHashExists, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.checkHashExists, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.ID_REQUIRED, 'no id');
            test_utils.assertErrorSync(search_util.checkHashExists, [env, HASH_ATTRIBUTE_NAME, "1"],
                undefined, 'all correct arguments');
        });

        it("test key exists", ()=>{
            let exists = test_utils.assertErrorSync(search_util.checkHashExists, [env, HASH_ATTRIBUTE_NAME, "1"],
                undefined, 'all correct arguments');

            assert.deepStrictEqual(exists, true, "hash exists");
        });

        it("test key does not exists", ()=>{
            let exists = test_utils.assertErrorSync(search_util.checkHashExists, [env, HASH_ATTRIBUTE_NAME, "111"],
                undefined, 'all correct arguments');

            assert.deepStrictEqual(exists, false, "hash exists");
        });
    });

    describe('test searchAll function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(SOME_ATTRIBUTES), MULTI_RECORD_ARRAY);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.searchAll, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.searchAll, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.searchAll, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_REQUIRED, 'no fetch_attributes');
            test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_MUST_BE_ARRAY, 'invalid fetch_attributes');
            test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES], undefined, 'all arguments sent');
        });

        it("searchAll rows", ()=>{

            let rows = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES], undefined, 'search');

            let expected = {
                "1":{id: 1, name: 'Kyle', age: 46, city: 'Denver'},
                "2":{id: 2, name: 'Jerry', age: 32, city: undefined},
                "3":{id: 3, name: 'Hank', age: 57, city: undefined},
            expected.push(test_utils.assignObjecttoNullObject({id: 4, name: 'Joy', age: 44, city: 'Denver'}));
        };
            assert.deepStrictEqual(rows, expected);
        });
    });

    describe('test searchAllToMap function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(SOME_ATTRIBUTES), MULTI_RECORD_ARRAY);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.searchAllToMap, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.searchAllToMap, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.searchAllToMap, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.searchAllToMap, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_REQUIRED, 'no fetch_attributes');
            test_utils.assertErrorSync(search_util.searchAllToMap, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_MUST_BE_ARRAY, 'invalid fetch_attributes');
            test_utils.assertErrorSync(search_util.searchAllToMap, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES], undefined, 'all arguments sent');
        });

        it("searchAllToMap rows", ()=>{

            let rows = test_utils.assertErrorSync(search_util.searchAllToMap, [env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES], undefined, 'search');

            let expected = Object.create(null);
            expected['1'] = test_utils.assignObjecttoNullObject({id:1, name:'Kyle', age:46, city:'Denver'});
            expected['2'] = test_utils.assignObjecttoNullObject({id:2, name:'Jerry', age:32, city:undefined});
            expected['3'] = test_utils.assignObjecttoNullObject({id:3, name: 'Hank', age: 57, city:undefined});
            expected['4'] = test_utils.assignObjecttoNullObject({id:4, name:'Joy', age: 44, city:'Denver'});
            assert.deepStrictEqual(rows, expected);
        });
    });

    describe('test countAll function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(SOME_ATTRIBUTES), MULTI_RECORD_ARRAY);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.countAll, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.countAll, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.countAll, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.countAll, [env, HASH_ATTRIBUTE_NAME], undefined, 'all arguments');
        });

        it("test count", () => {
            let count = test_utils.assertErrorSync(search_util.countAll, [env, HASH_ATTRIBUTE_NAME], undefined, 'all arguments');
            assert.deepStrictEqual(count, 4);
        });
    });

    describe('test setGetWholeRowFlag function', ()=> {
        it("test just * in get_attributes", () => {
            let flag = test_utils.assertErrorSync(set_whole_row_flag, [['*']], undefined, 'all arguments');
            assert.deepStrictEqual(flag, true);
        });

        it("test just id in get_attributes", () => {
            let flag = test_utils.assertErrorSync(set_whole_row_flag, [['id']], undefined, 'all arguments');
            assert.deepStrictEqual(flag, false);
        });

        it("test just multiple attributes in get_attributes", () => {
            let flag = test_utils.assertErrorSync(set_whole_row_flag, [['id','name','age']], undefined, 'all arguments');
            assert.deepStrictEqual(flag, false);
        });
    });

    describe('test equals function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, lmdb_terms.DBI_KEY_TYPES.STRING, true);
            await environment_utility.createDBI(env, 'age', true, lmdb_terms.DBI_KEY_TYPES.NUMBER, false);
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(All_ATTRIBUTES), MULTI_RECORD_ARRAY);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.equals, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.equals, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.equals, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.equals, [env, 'city'], LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED, 'no search_value');
            test_utils.assertErrorSync(search_util.equals, [env, 'city', 'Denver'], undefined, 'all arguments');
        });

        it("test search on city", () => {
            let expected = Object.create(null);
            expected['1'] = test_utils.assignObjecttoNullObject({id:1, city: 'Denver'});
            expected['4'] = test_utils.assignObjecttoNullObject({id:4, city: 'Denver'});

            let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'city', 'Denver'], undefined, 'all arguments');
            assert.deepStrictEqual(results, expected);
        });

        it("test search on city, no hash", () => {
            let expected = Object.create(null);
            expected['1'] = test_utils.assignObjecttoNullObject({city: 'Denver'});
            expected['4'] = test_utils.assignObjecttoNullObject({city: 'Denver'});
            let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'city', 'Denver'], undefined, 'all arguments');
            assert.deepStrictEqual(results, expected);
        });

        it("test search on city with only partial value", () => {
            let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'city', 'Den'], undefined, 'all arguments');
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });

        it("test search on age (number attribute)", () => {
            let expected = Object.create(null);
            expected['1'] = test_utils.assignObjecttoNullObject({age: 46, id:1});

            let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'age', 46], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test search on age (number attribute) value doesn't exist", () => {
            let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'age', 100], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test search on hash attribute (id)", () => {
            let expected = Object.create(null);
            expected['1'] = test_utils.assignObjecttoNullObject({id:1});
            let results = test_utils.assertErrorSync(search_util.equals, [env, 'id','id', 1], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test search on hash attribute (id), value doesn't exist", () => {
            let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'id', 100], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });
    });

    describe('test startsWith function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, lmdb_terms.DBI_KEY_TYPES.STRING, true);
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(All_ATTRIBUTES), MULTI_RECORD_ARRAY2);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.startsWith, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.startsWith, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.startsWith, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.startsWith, [env, 'city'], LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED, 'no search_value');
            test_utils.assertErrorSync(search_util.startsWith, [env, 'city', 'D'], undefined, 'all arguments');
        });

        it("test search on city", () => {
            let expected = Object.create(null);
            expected['1'] = test_utils.assignObjecttoNullObject({"city": "Denver","id": 1});
            expected['4'] = test_utils.assignObjecttoNullObject({"city": "Denver","id": 4});
            expected['5'] = test_utils.assignObjecttoNullObject({"city": "Denvertown","id": 5});

            let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'city', 'Den'], undefined, 'all arguments');
            assert.deepStrictEqual(results, expected);
        });

        it("test search on city, no hash", () => {
            let expected = Object.create(null);
            expected['1'] = test_utils.assignObjecttoNullObject({"city": "Denver"});
            expected['4'] = test_utils.assignObjecttoNullObject({"city": "Denver"});
            expected['5'] = test_utils.assignObjecttoNullObject({"city": "Denvertown"});

            let results = test_utils.assertErrorSync(search_util.startsWith, [env, undefined, 'city', 'Den'], undefined, 'all arguments');
            assert.deepStrictEqual(results, expected);
        });

        it("test search on city with Denver", () => {
            let expected = Object.create(null);
            expected['1'] = test_utils.assignObjecttoNullObject({"city": "Denver","id": 1});
            expected['4'] = test_utils.assignObjecttoNullObject({"city": "Denver","id": 4});
            expected['5'] = test_utils.assignObjecttoNullObject({"city": "Denvertown","id": 5});
            let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'city', 'Denver'], undefined, 'all arguments');
            assert.deepStrictEqual(results, expected);
        });

        it("test search on city with Denvert", () => {
            let expected = Object.create(null);
            expected['5'] = test_utils.assignObjecttoNullObject({"city": "Denvertown","id": 5});
            let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'city', 'Denvert'], undefined, 'all arguments');
            assert.deepStrictEqual(results, expected);
        });

        it("test search on city with non-existent value", () => {
            let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'city', 'FoCo'], undefined, 'all arguments');
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id','fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });

        it("test search on hash attribute", () => {
            let expected = Object.create(null);
            expected['1'] = test_utils.assignObjecttoNullObject({"id": 1});
            let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id','id', '1'], undefined);
            assert.deepStrictEqual(results, expected);
        });
    });

    describe('test endsWith function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, lmdb_terms.DBI_KEY_TYPES.STRING, true);
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(All_ATTRIBUTES), MULTI_RECORD_ARRAY2);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.endsWith, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.endsWith, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.endsWith, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.endsWith, [env, 'city'], LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED, 'no search_value');
            test_utils.assertErrorSync(search_util.endsWith, [env, 'city', 'Denver'], undefined, 'all arguments');
        });

        it("test search on city", () => {
            let expected = Object.create(null);
            expected['1'] = test_utils.assignObjecttoNullObject({"id": 1, city: 'Denver'});
            expected['4'] = test_utils.assignObjecttoNullObject({"id": 4, city: 'Denver'});
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'city', 'ver'], undefined, 'all arguments');
            assert.deepStrictEqual(results, expected);
        });

        it("test search on city, no hash", () => {
            let expected = Object.create(null);
            expected['1'] = test_utils.assignObjecttoNullObject({city: 'Denver'});
            expected['4'] = test_utils.assignObjecttoNullObject({city: 'Denver'});
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, undefined, 'city', 'ver'], undefined, 'all arguments');
            assert.deepStrictEqual(results, expected);
        });

        it("test search on city with Denver", () => {
            let expected = Object.create(null);
            expected['1'] = test_utils.assignObjecttoNullObject({id: 1, city: 'Denver'});
            expected['4'] = test_utils.assignObjecttoNullObject({id: 4, city: 'Denver'});
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id','city', 'Denver'], undefined, 'all arguments');
            assert.deepStrictEqual(results, expected);
        });

        it("test search on city with town", () => {
            let expected = Object.create(null);
            expected['5'] = test_utils.assignObjecttoNullObject({id: 5, city: 'Denvertown'});
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'city', 'town'], undefined, 'all arguments');
            assert.deepStrictEqual(results, expected);
        });

        it("test search on city with non-existent value", () => {
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'city', 'FoCo'], undefined, 'all arguments');
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id','fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });

        it("test search on hash attribute", () => {
            let expected = Object.create(null);
            expected['1'] = test_utils.assignObjecttoNullObject({id: 1});
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'id', '1'], undefined);
            assert.deepStrictEqual(results, expected);
        });
    });

    describe('test greaterThan function', ()=> {
        let env;

        function createExpected(attribute, value){
            let expected = Object.create(null);

            for(let x = 0; x < test_data.length; x++){
                let attr_value = isNaN(test_data[x][attribute]) ? test_data[x][attribute] : Number(test_data[x][attribute]);
                if(attr_value > value){
                    let id = test_data[x].id;
                    expected[id.toString()] = test_utils.assignObjecttoNullObject({id: Number(id)});
                    expected[id.toString()][attribute] = attr_value;
                }
            }

            return expected;
        }

        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, lmdb_terms.DBI_KEY_TYPES.STRING, true);
            await environment_utility.createDBI(env, 'temperature', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            await environment_utility.createDBI(env, 'temperature_double', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            await environment_utility.createDBI(env, 'temperature_str', true, lmdb_terms.DBI_KEY_TYPES.STRING);
            await environment_utility.createDBI(env, 'state', true, lmdb_terms.DBI_KEY_TYPES.STRING);

            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ['id', 'temperature','temperature_double', 'temperature_str', 'state'], test_data);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.greaterThan, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.greaterThan, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.greaterThan, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.greaterThan, [env, 'temperature'], LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED, 'no search_value');
            test_utils.assertErrorSync(search_util.greaterThan, [env, 'temperature_str', '11111111'], undefined, 'all arguments');
            test_utils.assertErrorSync(search_util.greaterThan, [env, 'temperature', 'tester'], LMDB_TEST_ERRORS.CANNOT_COMPARE_STRING_TO_NUMERIC_KEYS, 'bad key search');
        });

        /** TEST HASH ATTRIBUTE **/
        it("test greater than 100 on hash column", () => {
            let expected = createExpected('id', 100);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'id', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 11 on hash column", () => {
            let expected = createExpected('id', 11);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'id', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 0 on hash column", () => {
            let expected = createExpected('id', 0);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, undefined, 'id', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 1001 (max value) on hash column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, undefined, 'id', '1001'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test greater than 1111 (a value larger than the max) on hash column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'id', '1111'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test greater than -8 on hash column", () => {
            let expected = createExpected('id', -8);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'id', '-8'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        /** TEST FLOAT **/
        it("test greater than 100 on double key column", () => {
            let expected = createExpected('temperature_double', 100);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature_double', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 11 on double key column", () => {
            let expected = createExpected('temperature_double', 11);
            Object.values(expected).forEach(obj=>{
                delete obj.id;
            });

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, undefined, 'temperature_double', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 0 on double key column", () => {
            let expected = createExpected('temperature_double', 0);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature_double', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 111 (max temperature) on double key column", () => {
            let expected = createExpected('temperature_double', 111);
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature_double', '111'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test greater than 110 (a temperature not indexed) on double key column", () => {
            let expected = createExpected('temperature_double', 110);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature_double', '110'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 1111 (a value larger than the max) on double key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature_double', '1111'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test greater than -8.854640366043895 on double key column", () => {
            let expected = createExpected('temperature_double', -8.854640366043895);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature_double', '-8.854640366043895'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        /** TEST int **/
        it("test greater than 100 on int key column", () => {
            let expected = createExpected('temperature', 100);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 11 on int key column", () => {
            let expected = createExpected('temperature', 11);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 0 on uint key column", () => {
            let expected = createExpected('temperature', 0);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 111 (max temperature) on uint key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature', '111'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test greater than 110 (a temperature not indexed) on uint key column", () => {
            let expected = createExpected('temperature', 110);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature', '110'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 1111 (a value larger than the max) on uint key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature', '1111'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test greater than -8 on int key column", () => {
            let expected = createExpected('temperature', -8);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature', '-8'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        /** STRING **/
        it("test greater than 100 on string key column", () => {
            let expected = createExpected('temperature_str', 100);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature_str', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 11 on string key column", () => {
            let expected = createExpected('temperature_str', 11);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature_str', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 0 on string key column", () => {
            let expected = createExpected('temperature_str', 0);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature_str', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 111 (max temperature) on string key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature_str', '111'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test greater than 110 (a temperature not indexed) on string key column", () => {
            let expected = createExpected('temperature_str', 110);

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature_str', '110'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 1111 on string key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'temperature', '1111'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test greater than CO on string key column", () => {
            let expected = createExpected('state', 'CO');
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'state', 'CO'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than W on string key column", () => {
            let expected = createExpected('state', 'W');

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'state', 'W'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than CC on string key column", () => {
            let expected = createExpected('state', 'CC');

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'state', 'CC'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than WY (last state code) on string key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'state', 'WY'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test greater than AK (first state code) on string key column", () => {
            let expected = createExpected('state', 'AK');
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'state', 'AK'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than 1111 on state string key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'state', '1111'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
    });

    describe('test greaterThanEqual function', ()=> {
        function createExpected(attribute, value){
            let expected = Object.create(null);

            for(let x = 0; x < test_data.length; x++){
                let attr_value = isNaN(test_data[x][attribute]) ? test_data[x][attribute] : Number(test_data[x][attribute]);
                if(attr_value >= value){
                    let id = test_data[x].id;
                    expected[id.toString()] = test_utils.assignObjecttoNullObject({id: Number(id)});
                    expected[id.toString()][attribute] = attr_value;
                }
            }

            return expected;
        }

        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, lmdb_terms.DBI_KEY_TYPES.STRING, true);
            await environment_utility.createDBI(env, 'temperature', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            await environment_utility.createDBI(env, 'temperature_double', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            await environment_utility.createDBI(env, 'temperature_str', true, lmdb_terms.DBI_KEY_TYPES.STRING);
            await environment_utility.createDBI(env, 'state', true, lmdb_terms.DBI_KEY_TYPES.STRING);

            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ['id', 'temperature', 'temperature_double', 'temperature_str', 'state'], test_data);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.greaterThanEqual, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.greaterThanEqual, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.greaterThanEqual, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'temperature'], LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED, 'no search_value');
            test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'temperature_str', '11111111'], undefined, 'all arguments');
            test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'temperature', 'tester'], LMDB_TEST_ERRORS.CANNOT_COMPARE_STRING_TO_NUMERIC_KEYS, 'bad key search');
        });

        /** TEST HASH ATTRIBUTE **/
        it("test greater than equal 100 on hash column", () => {
            let expected = createExpected('id', '100');

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'id', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal 11 on hash column", () => {
            let expected = createExpected('id', 11);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, undefined, 'id', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal 0 on hash column", () => {
            let expected = createExpected('id', 0);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'id', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal 1000 (max value) on hash column", () =>{
            let expected = createExpected('id', 1000);
            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'id', '1000'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal 1111 (a value larger than the max) on hash column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'id', '1111'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test greater than equal -8 on hash column", () => {
            let expected = createExpected('id', -8);
            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'id', '-8'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        /** DOUBLE **/
        it("test greaterThanEqual 100 on double key column", () => {
            let expected = createExpected('temperature_double', 100);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature_double', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greaterThanEqual 11 on double key column", () => {
            let expected = createExpected('temperature_double', 11);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature_double', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greaterThanEqual 0 on double key column", () => {
            let expected = createExpected('temperature_double', 0);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature_double', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal 111 on double key column", () => {
            let expected = createExpected('temperature_double', 111);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature_double', '111'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal 1111 on double key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature_double', '1111'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test greaterThanEqual 110 (a temperature not indexed) on double key column", () => {
            let expected = createExpected('temperature_double', 110);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature_double', '110'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal -8.854640366043895 on double key column", () => {
            let expected = createExpected('temperature_double', -8.854640366043895);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature_double', '-8.854640366043895'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        /** INT **/

        it("test greaterThanEqual 100 on int key column", () => {
            let expected = createExpected('temperature', 100);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greaterThanEqual 11 on int key column", () => {
            let expected = createExpected('temperature', 11);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greaterThanEqual 0 on int key column", () => {
            let expected = createExpected('temperature', 0);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal 111 on int key column", () => {
            let expected = createExpected('temperature', 111);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature', '111'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal 1111 on int key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature', '1111'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test greaterThanEqual 110 (a temperature not indexed) on int key column", () => {
            let expected = createExpected('temperature', 110);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature', '110'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greaterThanEqual -8 on int key column", () => {
            let expected = createExpected('temperature', -8);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature', '-8'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greaterThanEqual -111 on int key column", () => {
            let expected = createExpected('temperature', -111);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature', '-111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        /** STRING **/
        it("test greater than equal 100 on string key column", () =>{
            let expected = createExpected('temperature_str', 100);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature_str', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal 11 on string key column", () => {
            let expected = createExpected('temperature_str', 11);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature_str', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal 0 on string key column", () => {
            let expected = createExpected('temperature_str', 0);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature_str', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal 111 on string key column", () => {
            let expected = createExpected('temperature_str', 111);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature_str', '111'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal 110 on string key column", () => {
            let expected = createExpected('temperature_str', 110);

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature_str', '110'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal 1111 on string key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'temperature', '1111'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test greater than equal CO on string key column", () => {
            let expected = createExpected('state', 'CO');

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'state', 'CO'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal W on string key column", () => {
            let expected = createExpected('state', 'W');

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'state', 'W'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal WY on state key column", () => {
            let expected = createExpected('state', 'WY');

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'state', 'WY'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal CC on state key column", () => {
            let expected = createExpected('state', 'CC');

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'state', 'CC'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal AK on state key column", () => {
            let expected = createExpected('state', 'AK');

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'state', 'AK'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal A on state key column", () => {
            let expected = createExpected('state', 'A');

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'state', 'A'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test greater than equal 1111 on state string key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'state', '1111'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
    });

    describe('test lessThan function', ()=> {
        function createExpected(attribute, value){
            let expected = Object.create(null);

            for(let x = 0; x < test_data.length; x++){
                let attr_value = isNaN(test_data[x][attribute]) ? test_data[x][attribute] : Number(test_data[x][attribute]);
                if(attr_value < value){
                    let id = test_data[x].id;
                    expected[id.toString()] = test_utils.assignObjecttoNullObject({id: Number(id)});
                    expected[id.toString()][attribute] = attr_value;
                }
            }

            return expected;
        }

        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, lmdb_terms.DBI_KEY_TYPES.STRING, true);
            await environment_utility.createDBI(env, 'temperature', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            await environment_utility.createDBI(env, 'temperature_double', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            await environment_utility.createDBI(env, 'temperature_str', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            await environment_utility.createDBI(env, 'state', true, lmdb_terms.DBI_KEY_TYPES.STRING);

            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ['id', 'temperature', 'temperature_double', 'temperature_str', 'state'], test_data);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.lessThan, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.lessThan, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.lessThan, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.lessThan, [env, 'temperature'], LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED, 'no search_value');
            test_utils.assertErrorSync(search_util.lessThan, [env, 'temperature_str', '11111111'], undefined, 'all arguments');
            test_utils.assertErrorSync(search_util.lessThan, [env, 'temperature', 'tester'], LMDB_TEST_ERRORS.CANNOT_COMPARE_STRING_TO_NUMERIC_KEYS, 'bad key search');
        });

        /** TEST HASH ATTRIBUTE **/
        it("test lessThan 100 on hash column", () => {
            let expected = createExpected('id', 100);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'id', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 11 on hash column", () => {
            let expected = createExpected('id', 11);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'id', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 0 on hash column", () => {
            let expected = createExpected('id', 0);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'id', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 1000 (max value) on hash column", () => {
            let expected = createExpected('id', 1000);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'id', '1000'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 1111 (a value larger than the max) on hash column", () =>{
            let expected = createExpected('id', 1111);
            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'id', '1111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan -8 on hash column", () => {
            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'id', '-8'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        /**DOUBLE**/

        it("test lessThan 100 on double key column", () => {
            let expected = createExpected('temperature_double', 100);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature_double', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 11 on double key column", () => {
            let expected = createExpected('temperature_double', 11);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature_double', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 0 on double key column", () => {
            let expected = createExpected('temperature_double', 0);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature_double', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 111 on double key column", () => {
            let expected = createExpected('temperature_double', 111);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature_double', '111'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 1111 on double key column", () => {
            let expected = createExpected('temperature_double', 1111);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature_double', '1111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan -8.854640366043895  on double key column", () => {
            let expected = createExpected('temperature_double', -8.854640366043895);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature_double', '-8.854640366043895'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan -888.854640366043895  on double key column", () => {
            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature_double', '-888.854640366043895'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        /** INT **/

        it("test lessThan 100 on numeric key column", () => {
            let expected = createExpected('temperature', 100);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 11 on numeric key column", () => {
            let expected = createExpected('temperature', 11);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 0 on numeric key column", () => {
            let expected = createExpected('temperature', 0);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 111 on numeric key column", () => {
            let expected = createExpected('temperature', 111);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature', '111'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 1111 on numeric key column", () => {
            let expected = createExpected('temperature', 1111);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature', '1111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 110 (a temperature not indexed) on numeric key column", () => {
            let expected = createExpected('temperature', 110);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature', '110'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan -8  on numeric key column", () => {
            let expected = createExpected('temperature', -8);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature', '-8'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan -888  on numeric key column", () => {
            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature', '-888'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        /** STRING **/

        it("test lessThan 100 on string key column", () => {
            let expected = createExpected('temperature_str', 100);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature_str', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 11 on string key column", () => {
            let expected = createExpected('temperature_str', 11);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature_str', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 0 on string key column", () => {
            let expected = createExpected('temperature_str', 0);
            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature_str', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 111 on string key column", () => {
            let expected = createExpected('temperature_str', 111);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature_str', '111'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 110 on string key column", () => {
            let expected = createExpected('temperature_str', 110);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature_str', '110'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan 1111 on string key column", () => {
            let expected = createExpected('temperature_str', 1111);

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'temperature_str', '1111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan CO on string key column", () =>{
            let expected = createExpected('state', 'CO');

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'state', 'CO'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan W on string key column", () => {
            let expected = createExpected('state', 'W');

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'state', 'W'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan WY on state key column", () => {
            let expected = createExpected('state', 'WY');

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'state', 'WY'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan CC on state key column", () => {
            let expected = createExpected('state', 'CC');

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'state', 'CC'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThan AK on state key column", () => {

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'state', 'AK'], undefined);
            assert.deepStrictEqual(results, Object.create((null)));
        });

        it("test lessThan A on state key column", () => {
            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'state', 'A'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test lessThan 1111 on state string key column", () => {
            let expected = createExpected('state', '1111');

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'state', '1111'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
    });

    describe('test lessThanEqual function', ()=> {
        function createExpected(attribute, value){
            let expected = Object.create(null);

            for(let x = 0; x < test_data.length; x++){
                let attr_value = isNaN(test_data[x][attribute]) ? test_data[x][attribute] : Number(test_data[x][attribute]);
                if(attr_value <= value){
                    let id = test_data[x].id;
                    expected[id.toString()] = test_utils.assignObjecttoNullObject({id: Number(id)});
                    expected[id.toString()][attribute] = attr_value;
                }
            }

            return expected;
        }

        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, lmdb_terms.DBI_KEY_TYPES.STRING, true);
            await environment_utility.createDBI(env, 'temperature', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            await environment_utility.createDBI(env, 'temperature_double', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            await environment_utility.createDBI(env, 'temperature_str', true, lmdb_terms.DBI_KEY_TYPES.STRING);
            await environment_utility.createDBI(env, 'state', true, lmdb_terms.DBI_KEY_TYPES.STRING);

            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ['id', 'temperature', 'temperature_double', 'temperature_str', 'state'], test_data);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.lessThanEqual, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.lessThanEqual, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.lessThanEqual, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'temperature'], LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED, 'no search_value');
            test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'temperature_str', '11111111'], undefined, 'all arguments');
            test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'temperature', 'tester'], LMDB_TEST_ERRORS.CANNOT_COMPARE_STRING_TO_NUMERIC_KEYS, 'bad key search');
        });

        /** TEST HASH ATTRIBUTE **/
        it("test lessThanEqual 100 on hash column", () => {
            let expected = createExpected('id', 100);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'id', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 11 on hash column", () => {
            let expected = createExpected('id', 11);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'id', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 0 on hash column", () => {
            let expected = createExpected('id', 0);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'id', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 1000 (max value) on hash column", () => {
            let expected = createExpected('id', 1000);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'id', '1000'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 1111 (a value larger than the max) on hash column", () => {
            let expected = createExpected('id', 1111);
            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'id', '1111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual -8 on hash column", () => {
            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'id', '-8'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        /** DOUBLE **/
        it("test lessThanEqual 100 on double key column", () => {
            let expected = createExpected('temperature_double', 100);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature_double', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 11 on double key column", () => {
            let expected = createExpected('temperature_double', 11)

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature_double', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 0 on double key column", () => {
            let expected = createExpected('temperature_double', 0);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature_double', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 111 on double key column", () => {
            let expected = createExpected('temperature_double', 111);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature_double', '111'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 1111 on double key column", () => {
            let expected = createExpected('temperature_double', 1111);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature_double', '1111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 110 (a temperature not indexed) on double key column", () => {
            let expected = createExpected('temperature_double', 110);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature_double', '110'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual -8.854640366043895 on double key column", () => {
            let expected = createExpected('temperature_double', -8.854640366043895);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature_double', '-8.854640366043895'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual -888.854640366043895 on double key column", () => {
             let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature_double', '-888.854640366043895'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        /** INT **/
        it("test lessThanEqual 100 on int key column", () => {
            let expected = createExpected('temperature', 100);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 11 on int key column", () => {
            let expected = createExpected('temperature', 11);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 0 on int key column", () => {
            let expected = createExpected('temperature', 0);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 111 on int key column", () => {
            let expected = createExpected('temperature', 111);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature', '111'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 1111 on int key column", () => {
            let expected = createExpected('temperature', 1111);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature', '1111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 110 (a temperature not indexed) on int key column", () => {
            let expected = createExpected('temperature', 110);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature', '110'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual -8 on int key column", () => {
            let expected = createExpected('temperature', -8);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature', '-8'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual -888 (a temperature not indexed) on int key column", () => {
            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature', '-888'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        /** string **/
        it("test lessThanEqual 100 on string key column", () => {
            let expected = createExpected('temperature_str', 100);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature_str', '100'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 11 on string key column", () => {
            let expected = createExpected('temperature_str', 11);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature_str', '11'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 0 on string key column", () => {
            let expected = createExpected('temperature_str', 0);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature_str', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 111 on string key column", () => {
            let expected = createExpected('temperature_str', 111);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature_str', '111'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 110 on string key column", () => {
            let expected = createExpected('temperature_str', 110);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature_str', '110'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual 1111 on string key column", () => {
            let expected = createExpected('temperature_str', 1111);

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'temperature_str', '1111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual CO on string key column", () => {
            let expected = createExpected('state', 'CO');

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'state', 'CO'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual W on string key column", () => {
            let expected = createExpected('state', 'W');

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'state', 'W'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual WY on state key column", () => {
            let expected = createExpected('state', 'WY');

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'state', 'WY'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual CC on state key column", () => {
            let expected = createExpected('state', 'CC');

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'state', 'CC'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual AK on state key column", () => {
            let expected = createExpected('state', 'AK');

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'state', 'AK'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test lessThanEqual A on state key column", () => {
            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'state', 'A'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test lessThanEqual 1111 on state string key column", () => {
            let expected = createExpected('state', '1111');

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'state', '1111'], undefined);
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
    });

    describe('test between function', ()=> {
        function createExpected(attribute, start_value, end_value){
            let expected = Object.create(null);

            for(let x = 0; x < test_data.length; x++){
                let attr_value = isNaN(test_data[x][attribute]) ? test_data[x][attribute] : Number(test_data[x][attribute]);
                if(attr_value >= start_value && attr_value <= end_value){
                    let id = test_data[x].id;
                    expected[id.toString()] = test_utils.assignObjecttoNullObject({id: Number(id)});
                    expected[id.toString()][attribute] = attr_value;
                }
            }

            return expected;
        }

        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, lmdb_terms.DBI_KEY_TYPES.STRING, true);
            await environment_utility.createDBI(env, 'temperature', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            await environment_utility.createDBI(env, 'temperature_double', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            await environment_utility.createDBI(env, 'temperature_str', true, lmdb_terms.DBI_KEY_TYPES.STRING);
            await environment_utility.createDBI(env, 'state', true, lmdb_terms.DBI_KEY_TYPES.STRING);

            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ['id', 'temperature', 'temperature_double', 'temperature_str', 'state'], test_data);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.between, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.between, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.between, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no attribute');
            test_utils.assertErrorSync(search_util.between, [env, 'temperature'], LMDB_TEST_ERRORS.START_VALUE_REQUIRED, 'no start value');
            test_utils.assertErrorSync(search_util.between, [env, 'temperature', 11], LMDB_TEST_ERRORS.END_VALUE_REQUIRED, 'no end value');
            test_utils.assertErrorSync(search_util.between, [env, 'temperature', 11, 1], LMDB_TEST_ERRORS.END_VALUE_MUST_BE_GREATER_THAN_START_VALUE, 'end less than start');
            test_utils.assertErrorSync(search_util.between, [env, 'temperature', 'tester', 'zzz'], LMDB_TEST_ERRORS.CANNOT_COMPARE_STRING_TO_NUMERIC_KEYS, 'bad key search');
            test_utils.assertErrorSync(search_util.between, [env, 'temperature', 1, 'zzz'], LMDB_TEST_ERRORS.CANNOT_COMPARE_STRING_TO_NUMERIC_KEYS, 'bad key search');

            test_utils.assertErrorSync(search_util.between, [env, 'temperature', 'tester', 11], LMDB_TEST_ERRORS.CANNOT_COMPARE_STRING_TO_NUMERIC_KEYS, 'bad key search');
            test_utils.assertErrorSync(search_util.between, [env, 'temperature', 1, 11], undefined, 'allgood');
            test_utils.assertErrorSync(search_util.between, [env, 'temperature_str', 'CC', 'A'], LMDB_TEST_ERRORS.END_VALUE_MUST_BE_GREATER_THAN_START_VALUE, 'end less than start');
            test_utils.assertErrorSync(search_util.between, [env, 'temperature_str', 'A', 'CC'], undefined, 'end less than start');
        });

        /** HASH ATTRIBUTE **/

        it("test between 11 & 100 on hash column", () => {
            let expected = createExpected('id', 11, 100);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'id', '11', 100], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test between 0 and 111 on hash column", () => {
            let expected = createExpected('id', 0, 111);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'id', '0', '111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test between 0 and 11111 on hash column", () => {
            let expected = createExpected('id', 0, 11111);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id','id', '0', '11111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test between 110 and 111 on hash column", () => {
            let expected = createExpected('id', 110, 111);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'id', '110', '111'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });


        it("test between -8999 and 1111 on hash column", () => {
            let expected = createExpected('id', -8999, 1111);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'id', '-8999', '1111'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test between -2 and 10 on hash column", () => {
            let expected = createExpected('id', -2, 10);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'id', '-2', '10'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test between -2 and 0 on hash column", () => {
            let expected = createExpected('id', -2, 0);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'id', '-2', '0'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        /** DOUBLE **/

        it("test between 11 & 100 on double key column", () => {
            let expected = createExpected('temperature_double', 11, 100);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature_double', '11', 100], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test between 0 and 111 on double key column", () => {
            let expected = createExpected('temperature_double', 0, 111);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature_double', '0', '111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test between 0 and 11111 on double key column", () => {
            let expected = createExpected('temperature_double', 0, 11111);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature_double', '0', '11111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test between 110 and 111 on double key column", () => {
            let expected = createExpected('temperature_double', 110, 111);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature_double', '110', '111'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test between -8.77 and -2.24564 on double key column", () => {
            let expected = createExpected('temperature_double', -8.77, -2.24564);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature_double', '-8.77', '-2.24564'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test between -8999 and 1111 on double key column", () => {
            let expected = createExpected('temperature_double', -8999, 1111);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature_double', '-8999', '1111'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test between -2.24564 and 10.432 on double key column", () => {
            let expected = createExpected('temperature_double', -2.24564, 10.432);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature_double', '-2.24564', '10.432'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test between -2.24564 and 0 on double key column", () => {
            let expected = createExpected('temperature_double', -2.24564, 0);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature_double', '-2.24564', '0'], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        /** INT **/

        it("test between 11 & 100 on int key column", () => {
            let expected = createExpected('temperature', 11, 100);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature', '11', 100], undefined);
            assert.notDeepStrictEqual(results, Object.create(null));
            assert.deepStrictEqual(results, expected);
        });

        it("test between 0 and 111 on int key column", () => {
            let expected = createExpected('temperature', 0, 111);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature', '0', '111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test between 0 and 11111 on int key column", () => {
            let expected = createExpected('temperature', 0, 11111);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature', '0', '11111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test between 110 and 111 on int key column", () => {
            let expected = createExpected('temperature', 110, 111);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature', '110', '111'], undefined);
            assert.deepStrictEqual(results, expected);
        });


        it("test between -8 and -2 on int key column", () => {
            let expected = createExpected('temperature', -8, -2);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature', '-8', '-2'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test between -8999 and 1111 on int key column", () => {
            let expected = createExpected('temperature', -8999, 1111);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature', '-8999', '1111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test between -2 and 10 on int key column", () => {
            let expected = createExpected('temperature', -2, 10);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature', '-2', '10'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test between -2 and 0 on int key column", () => {
            let expected = createExpected('temperature', -2, 0);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature', '-2', '0'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        /** STRING **/

        it("test between 11 & 100 on string key column", () => {
            let expected = createExpected('temperature_str', 11, 100);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature_str', '11', 100], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test between 0 and 111 on string key column", () => {
            let expected = createExpected('temperature_str', 0, 111);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature_str', '0', '111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test between 0 and 11111 on string key column", () => {
            let expected = createExpected('temperature_str', 0, 11111);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature_str', '0', '11111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test between 110 and 111 on string key column", () => {
            let expected = createExpected('temperature_str', 110, 111);

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'temperature_str', '110', '111'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test between CO and WY on string key column", () => {
            let expected = createExpected('state', 'CO', 'WY');

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'state', 'CO', 'WY'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test between C and W on string key column", () => {
            let expected = createExpected('state', 'C', 'W');

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'state', 'C', 'W'], undefined);
            assert.deepStrictEqual(results, expected);
        });

        it("test between A and Z on string key column", () => {
            let expected = createExpected('state', 'A', 'Z');

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'state', 'A', 'Z'], undefined);
            assert(Object.keys(results).length === 1001);
            assert.deepStrictEqual(results, expected);
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'fake', 'bad', 'good'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
    });

    describe('test contains function', ()=> {
        function createExpected(attribute, value){
            let expected = Object.create(null);

            for(let x = 0; x < MULTI_RECORD_ARRAY2.length; x++){
                let attr_value = isNaN(MULTI_RECORD_ARRAY2[x][attribute]) ? MULTI_RECORD_ARRAY2[x][attribute] : Number(MULTI_RECORD_ARRAY2[x][attribute]);
                if(attr_value && attr_value.toString().indexOf(value) >= 0){
                    let id = MULTI_RECORD_ARRAY2[x].id;
                    expected[id.toString()] = test_utils.assignObjecttoNullObject({id: Number(id)});
                    expected[id.toString()][attribute] = attr_value;
                }
            }

            return expected;
        }

        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(All_ATTRIBUTES), MULTI_RECORD_ARRAY2);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.contains, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.contains, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.contains, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.contains, [env, 'city'], LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED, 'no search_value');
            test_utils.assertErrorSync(search_util.contains, [env, 'city', 'Denver'], undefined, 'all arguments');
        });

        it("test search on city", () => {
            let expected = createExpected('city', 'ver');
            let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'city', 'ver'], undefined, 'all arguments');
            assert.deepStrictEqual(results, expected);
        });

        it("test search on city with Denver", () => {
            let expected = createExpected('city', 'Denver');
            let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'city', 'Denver'], undefined, 'all arguments');
            assert.deepStrictEqual(results, expected);
        });

        it("test search on city with town", () => {
            let expected = createExpected('city', 'town');
            let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'city', 'town'], undefined, 'all arguments');
            assert.deepStrictEqual(results, expected);
        });

        it("test search on city with non-existent value", () => {
            let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'city', 'FoCo'], undefined, 'all arguments');
            assert.deepStrictEqual(results, Object.create(null));
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.contains, [env, 'id','fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
    });

    describe('test iterateDBI function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(All_ATTRIBUTES), MULTI_RECORD_ARRAY2);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.iterateDBI, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.iterateDBI, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.iterateDBI, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.iterateDBI, [env, 'city'], undefined, 'no search_value');
        });

        it("test iterate on city", () => {
            let results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'city'], undefined, 'city iterate');
            assert.deepStrictEqual(results, [
                ['Denver', '1'],
                ['Denver', '4'],
                ['Denvertown', '5'],
            ]);
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.contains, [env, 'fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
    });
});