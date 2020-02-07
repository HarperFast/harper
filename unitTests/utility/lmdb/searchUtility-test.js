'use strict';

const rewire = require('rewire');
const search_util = rewire('../../../utility/lmdb/searchUtility');
const fs = require('fs-extra');
const environment_utility = rewire('../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../utility/lmdb/writeUtility');
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
    describe('test searchByHash function', ()=>{
        let env;
        let rw_env_util;
        before(async ()=>{
            rw_env_util = environment_utility.__set__('MAP_SIZE', 10*1024*1024*1024);
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, MULTI_RECORD_ARRAY);
        });

        after(async ()=>{
            rw_env_util();
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
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, MULTI_RECORD_ARRAY);
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
            let row = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, ["1"]],
                undefined, 'fetch single row');

            assert.deepStrictEqual(row, [test_utils.assignObjecttoNullObject( {id:1, name:'Kyle', age:46})]);
        });

        it("test fetch multiple records", ()=>{
            let row = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, ["1", "4", "2"]],
                undefined, 'fetch multi rows');

            assert.deepStrictEqual(row, [
                test_utils.assignObjecttoNullObject({id:1, name:'Kyle', age:46}),
                test_utils.assignObjecttoNullObject({id:4, name:'Joy', age: 44}),
                test_utils.assignObjecttoNullObject({id:2, name:'Jerry', age:32})]);
        });

        it("test fetch multiple records some don't exist", ()=>{
            let row = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, ["1","fake", "4", "55", "2"]],
                undefined, 'fetch single row');

            assert.deepStrictEqual(row, [test_utils.assignObjecttoNullObject({id:1, name:'Kyle', age:46}),
                test_utils.assignObjecttoNullObject({id:4, name:'Joy', age: 44}),
                test_utils.assignObjecttoNullObject({id:2, name:'Jerry', age:32})]);
        });
    });

    describe("Test batchSearchByHashToMap", ()=>{
        let env;
        before(async ()=>{
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, MULTI_RECORD_ARRAY);
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
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, MULTI_RECORD_ARRAY);
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
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, MULTI_RECORD_ARRAY);
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

            let expected = [];
            expected.push(test_utils.assignObjecttoNullObject( {id:1, name:'Kyle', age:46, city:'Denver'}));
            expected.push(test_utils.assignObjecttoNullObject( {id:2, name:'Jerry', age:32, city:undefined}));
            expected.push(test_utils.assignObjecttoNullObject( {id:3, name: 'Hank', age: 57, city:undefined}));
            expected.push(test_utils.assignObjecttoNullObject( {id:4, name:'Joy', age: 44, city:'Denver'}));
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
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, MULTI_RECORD_ARRAY);
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
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, MULTI_RECORD_ARRAY);
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
            await environment_utility.createDBI(env, 'id');
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, MULTI_RECORD_ARRAY);
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
            let results = test_utils.assertErrorSync(search_util.equals, [env, 'city', 'Denver'], undefined, 'all arguments');
            assert.deepStrictEqual(results, ['1', '4']);
        });

        it("test search on city with only partial value", () => {
            let results = test_utils.assertErrorSync(search_util.equals, [env, 'city', 'Den'], undefined, 'all arguments');
            assert.deepStrictEqual(results, []);
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.equals, [env, 'fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
    });

    describe('test startsWith function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, MULTI_RECORD_ARRAY2);
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
            let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'city', 'Den'], undefined, 'all arguments');
            assert.deepStrictEqual(results, ['1', '4', '5']);
        });

        it("test search on city with Denver", () => {
            let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'city', 'Denver'], undefined, 'all arguments');
            assert.deepStrictEqual(results, ['1', '4', '5']);
        });

        it("test search on city with Denvert", () => {
            let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'city', 'Denvert'], undefined, 'all arguments');
            assert.deepStrictEqual(results, ['5']);
        });

        it("test search on city with non-existent value", () => {
            let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'city', 'FoCo'], undefined, 'all arguments');
            assert.deepStrictEqual(results, []);
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
    });

    describe('test endsWith function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, MULTI_RECORD_ARRAY2);
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
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'city', 'ver'], undefined, 'all arguments');
            assert.deepStrictEqual(results, ['1', '4']);
        });

        it("test search on city with Denver", () => {
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'city', 'Denver'], undefined, 'all arguments');
            assert.deepStrictEqual(results, ['1', '4']);
        });

        it("test search on city with town", () => {
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'city', 'town'], undefined, 'all arguments');
            assert.deepStrictEqual(results, ['5']);
        });

        it("test search on city with non-existent value", () => {
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'city', 'FoCo'], undefined, 'all arguments');
            assert.deepStrictEqual(results, []);
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
    });

    describe('test greaterThan function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false);
            await environment_utility.createDBI(env, 'temperature', true, true);
            await environment_utility.createDBI(env, 'temperature_str', true, false);
            await environment_utility.createDBI(env, 'state', true, false);

            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ['id', 'temperature', 'temperature_str', 'state'], test_data);
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

        it("test greater than 100 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) > 100){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'temperature', '100'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than 11 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) > 11){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'temperature', '11'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than 0 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) > 0){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'temperature', '0'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than 111 (max temperature) on numeric key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'temperature', '111'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test greater than 110 (a temperature not indexed) on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) > 110){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'temperature', '110'], undefined);
            assert.deepStrictEqual(results.sort(), expected);
        });

        it("test greater than 1111 (a value larger than the max) on numeric key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'temperature', '1111'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test greater than 100 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) > 100){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'temperature_str', '100'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than 11 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) > 11){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'temperature_str', '11'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than 0 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) > 0){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'temperature_str', '0'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than 111 (max temperature) on string key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'temperature_str', '111'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test greater than 110 (a temperature not indexed) on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) > 110){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'temperature_str', '110'], undefined);
            assert.deepStrictEqual(results.sort(), expected);
        });

        it("test greater than 1111 on string key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'temperature', '1111'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test greater than CO on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state > 'CO'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'state', 'CO'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than W on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state > 'W'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'state', 'W'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than CC on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state > 'CC'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'state', 'CC'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than WY (last state code) on string key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'state', 'WY'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test greater than AK (first state code) on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state > 'AK'){
                    expected.push(test_data[x].id);
                }
            }
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'state', 'AK'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than 1111 on state string key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'state', '1111'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
    });

    describe('test greaterThanEqual function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false);
            await environment_utility.createDBI(env, 'temperature', true, true);
            await environment_utility.createDBI(env, 'temperature_str', true, false);
            await environment_utility.createDBI(env, 'state', true, false);

            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ['id', 'temperature', 'temperature_str', 'state'], test_data);
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

        it("test greaterThanEqual 100 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 100){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'temperature', '100'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greaterThanEqual 11 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 11){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'temperature', '11'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greaterThanEqual 0 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 0){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'temperature', '0'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than equal 111 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'temperature', '111'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than equal 1111 on numeric key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'temperature', '1111'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test greaterThanEqual 110 (a temperature not indexed) on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 110){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'temperature', '110'], undefined);
            assert.deepStrictEqual(results.sort(), expected);
        });

        it("test greater than equal 100 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 100){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'temperature_str', '100'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than equal 11 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 11){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'temperature_str', '11'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than equal 0 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 0){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'temperature_str', '0'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than equal 111 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'temperature_str', '111'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than equal 110 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 110){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'temperature_str', '110'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than equal 1111 on string key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'temperature', '1111'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test greater than equal CO on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state >= 'CO'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'state', 'CO'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than equal W on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state >= 'W'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'state', 'W'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than equal WY on state key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state >= 'WY'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'state', 'WY'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than equal CC on state key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state >= 'CC'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'state', 'CC'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than equal AK on state key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state >= 'AK'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'state', 'AK'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than equal A on state key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state >= 'A'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'state', 'A'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test greater than equal 1111 on state string key column", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'state', '1111'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
    });

    describe('test lessThan function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false);
            await environment_utility.createDBI(env, 'temperature', true, true);
            await environment_utility.createDBI(env, 'temperature_str', true, false);
            await environment_utility.createDBI(env, 'state', true, false);

            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ['id', 'temperature', 'temperature_str', 'state'], test_data);
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

        it("test lessThan 100 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) < 100){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'temperature', '100'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThan 11 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) < 11){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'temperature', '11'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThan 0 on numeric key column", () => {
            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'temperature', '0'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test lessThan 111 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) < 111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'temperature', '111'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThan 1111 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) < 1111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'temperature', '1111'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThan 110 (a temperature not indexed) on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) < 110){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'temperature', '110'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThan 100 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) < 100){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'temperature_str', '100'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThan 11 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) < 11){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'temperature_str', '11'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThan 0 on string key column", () => {
            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'temperature_str', '0'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test lessThan 111 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) < 111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'temperature_str', '111'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThan 110 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) < 110){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'temperature_str', '110'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThan 1111 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) < 1111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'temperature', '1111'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThan CO on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state < 'CO'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'state', 'CO'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThan W on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state < 'W'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'state', 'W'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThan WY on state key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state < 'WY'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'state', 'WY'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThan CC on state key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state < 'CC'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'state', 'CC'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThan AK on state key column", () => {

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'state', 'AK'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test lessThan A on state key column", () => {
            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'state', 'A'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test lessThan 1111 on state string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state < '1111'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'state', '1111'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
    });

    describe('test lessThanEqual function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false);
            await environment_utility.createDBI(env, 'temperature', true, true);
            await environment_utility.createDBI(env, 'temperature_str', true, false);
            await environment_utility.createDBI(env, 'state', true, false);

            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ['id', 'temperature', 'temperature_str', 'state'], test_data);
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

        it("test lessThanEqual 100 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) <= 100){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'temperature', '100'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual 11 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) <= 11){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'temperature', '11'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual 0 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) <= 0){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'temperature', '0'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual 111 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) <= 111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'temperature', '111'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual 1111 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) <= 1111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'temperature', '1111'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual 110 (a temperature not indexed) on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) <= 110){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'temperature', '110'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual 100 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) <= 100){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'temperature_str', '100'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual 11 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) <= 11){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'temperature_str', '11'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual 0 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) <= 0){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'temperature_str', '0'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual 111 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) <= 111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'temperature_str', '111'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual 110 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) <= 110){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'temperature_str', '110'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual 1111 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) <= 1111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'temperature', '1111'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual CO on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state <= 'CO'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'state', 'CO'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual W on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state <= 'W'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'state', 'W'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual WY on state key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state <= 'WY'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'state', 'WY'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual CC on state key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state <= 'CC'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'state', 'CC'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual AK on state key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state <= 'AK'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'state', 'AK'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test lessThanEqual A on state key column", () => {
            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'state', 'A'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test lessThanEqual 1111 on state string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state <= '1111'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'state', '1111'], undefined);
            assert.deepStrictEqual(results.sort(), []);
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
    });

    describe('test between function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false);
            await environment_utility.createDBI(env, 'temperature', true, true);
            await environment_utility.createDBI(env, 'temperature_str', true, false);
            await environment_utility.createDBI(env, 'state', true, false);

            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ['id', 'temperature', 'temperature_str', 'state'], test_data);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.between, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.between, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.between, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no hash attribute');
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

        it("test between 11 & 100 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) <= 100 && parseInt(test_data[x].temperature) >= 11){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.between, [env, 'temperature', '11', 100], undefined);
            assert.notDeepStrictEqual(results.sort(), []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test between 0 and 111 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 0 && parseInt(test_data[x].temperature) <= 111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.between, [env, 'temperature', '0', '111'], undefined);
            assert(results.length === 1001);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test between 0 and 11111 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 0 && parseInt(test_data[x].temperature) <= 11111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.between, [env, 'temperature', '0', '11111'], undefined);
            assert(results.length === 1001);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test between 110 and 111 on numeric key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 110 && parseInt(test_data[x].temperature) <= 111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.between, [env, 'temperature', '110', '111'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test between 11 & 100 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) <= 100 && parseInt(test_data[x].temperature) >= 11){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.between, [env, 'temperature_str', '11', 100], undefined);
            assert.notDeepStrictEqual(results.sort(), []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test between 0 and 111 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 0 && parseInt(test_data[x].temperature) <= 111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.between, [env, 'temperature_str', '0', '111'], undefined);
            assert(results.length === 1001);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test between 0 and 11111 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 0 && parseInt(test_data[x].temperature) <= 11111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.between, [env, 'temperature_str', '0', '11111'], undefined);
            assert(results.length === 1001);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test between 110 and 111 on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(parseInt(test_data[x].temperature) >= 110 && parseInt(test_data[x].temperature) <= 111){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.between, [env, 'temperature_str', '110', '111'], undefined);
            assert.notDeepStrictEqual(results, []);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test between CO and WY on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state >= 'CO' && test_data[x].state <= 'WY'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.between, [env, 'state', 'CO', 'WY'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test between C and W on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state >= 'C' && test_data[x].state <= 'W'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.between, [env, 'state', 'C', 'W'], undefined);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test between A and Z on string key column", () => {
            let expected = [];

            for(let x = 0; x < test_data.length; x++){
                if(test_data[x].state >= 'A' && test_data[x].state <= 'Z'){
                    expected.push(test_data[x].id);
                }
            }

            let results = test_utils.assertErrorSync(search_util.between, [env, 'state', 'A', 'Z'], undefined);
            assert(results.length === 1001);
            assert.deepStrictEqual(results.sort(), expected.sort());
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.between, [env, 'fake', 'bad', 'good'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
    });

    describe('test contains function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, MULTI_RECORD_ARRAY2);
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
            let results = test_utils.assertErrorSync(search_util.contains, [env, 'city', 'ver'], undefined, 'all arguments');
            assert.deepStrictEqual(results, ['1', '4', '5']);
        });

        it("test search on city with Denver", () => {
            let results = test_utils.assertErrorSync(search_util.contains, [env, 'city', 'Denver'], undefined, 'all arguments');
            assert.deepStrictEqual(results, ['1', '4', '5']);
        });

        it("test search on city with town", () => {
            let results = test_utils.assertErrorSync(search_util.contains, [env, 'city', 'town'], undefined, 'all arguments');
            assert.deepStrictEqual(results, ['5']);
        });

        it("test search on city with non-existent value", () => {
            let results = test_utils.assertErrorSync(search_util.contains, [env, 'city', 'FoCo'], undefined, 'all arguments');
            assert.deepStrictEqual(results, []);
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.contains, [env, 'fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
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
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, MULTI_RECORD_ARRAY2);
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