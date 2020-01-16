'use strict';

const search_util = require('../../../utility/lmdb/searchUtility');
const rewire = require('rewire');
const rw_search_util = rewire('../../../utility/lmdb/searchUtility');
const fs = require('fs-extra');
const environment_utility = require('../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../utility/lmdb/writeUtility');
const test_utils = require('../../test_utils');
const path = require('path');
const assert = require('assert');

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

const ENV_REQUIRED_ERROR = new Error('env is required');
const INVALID_ENVIRONMENT_ERROR = new Error('invalid environment object');
const FETCH_ATTRIBUTES_REQUIRED_ERROR = new Error('fetch_attributes is required');
const FETCH_ATTRIBUTES_NOT_ARRAY_ERROR = new Error('fetch_attributes must be an array');
const HASH_ATTRIBUTE_REQUIRED_ERROR = new Error('hash_attribute is required');
const ID_REQUIRED_ERROR = new Error('id is required');
const IDS_REQUIRED_ERROR = new Error('ids is required');
const IDS_NOT_ARRAY_ERROR = new Error('ids must be an array');
const ATTRIBUTE_REQUIRED_ERROR = new Error('attribute is required');
const SEARCH_VALUE_REQUIRED_ERROR = new Error('search_value is required');
const DBI_NO_EXIST_ERROR = new Error('dbi does not exist');

describe('Test searchUtility module', ()=>{
    describe('test searchByHash function', ()=>{
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
            test_utils.assertErrorSync(search_util.searchByHash, [], ENV_REQUIRED_ERROR, 'test no args');
            test_utils.assertErrorSync(search_util.searchByHash, [HASH_ATTRIBUTE_NAME], INVALID_ENVIRONMENT_ERROR, 'invalid env variable');
            test_utils.assertErrorSync(search_util.searchByHash, [env], HASH_ATTRIBUTE_REQUIRED_ERROR, 'no hash attribute');
            test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME], FETCH_ATTRIBUTES_REQUIRED_ERROR, 'no fetch_attributes');
            test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], FETCH_ATTRIBUTES_NOT_ARRAY_ERROR, 'invalid fetch_attributes');
            test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES], ID_REQUIRED_ERROR, 'no id');
            test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, MULTI_RECORD_ARRAY[0][HASH_ATTRIBUTE_NAME]],
                undefined, 'all arguments sent');
        });

        it("test select all attributes", ()=>{
            let record = test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, "3"],
                undefined, 'all arguments sent');

            assert.deepStrictEqual(record, MULTI_RECORD_ARRAY[2]);
        });

        it("test select record no exist", ()=>{
            let record = test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, "33"],
                undefined, 'all arguments sent');

            assert.deepStrictEqual(record, null);
        });

        it("test select record only id & name", ()=>{
            let record = test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, ["id", "name"], "2"],
                undefined, 'all arguments sent');

            assert.deepStrictEqual(record, {id:2, name:"Jerry"});
        });

        it("test select record only id & name and non-exsitent attribute", ()=>{
            let record = test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, ["id", "name", "dob"], "2"],
                undefined, 'all arguments sent');

            assert.deepStrictEqual(record, {id:2, name:"Jerry", dob:undefined});
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
            test_utils.assertErrorSync(search_util.batchSearchByHash, [], ENV_REQUIRED_ERROR, 'test no args');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [HASH_ATTRIBUTE_NAME], INVALID_ENVIRONMENT_ERROR, 'invalid env variable');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env], HASH_ATTRIBUTE_REQUIRED_ERROR, 'no hash attribute');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME], FETCH_ATTRIBUTES_REQUIRED_ERROR, 'no fetch_attributes');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], FETCH_ATTRIBUTES_NOT_ARRAY_ERROR, 'invalid fetch_attributes');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES], IDS_REQUIRED_ERROR, 'no id');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, "1"],
                IDS_NOT_ARRAY_ERROR, 'invalid ids');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, ["1", "3", "2"]],
                undefined, 'all correct arguments');
        });

        it("test fetch single record", ()=>{
            let row = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, ["1"]],
                undefined, 'fetch single row');

            assert.deepStrictEqual(row, [{id:1, name:'Kyle', age:46}]);
        });

        it("test fetch multiple records", ()=>{
            let row = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, ["1", "4", "2"]],
                undefined, 'fetch multi rows');

            assert.deepStrictEqual(row, [{id:1, name:'Kyle', age:46}, {id:4, name:'Joy', age: 44}, {id:2, name:'Jerry', age:32}]);
        });

        it("test fetch multiple records some don't exist", ()=>{
            let row = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, ["1","fake", "4", "55", "2"]],
                undefined, 'fetch single row');

            assert.deepStrictEqual(row, [{id:1, name:'Kyle', age:46}, {id:4, name:'Joy', age: 44}, {id:2, name:'Jerry', age:32}]);
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
            test_utils.assertErrorSync(search_util.checkHashExists, [], ENV_REQUIRED_ERROR, 'test no args');
            test_utils.assertErrorSync(search_util.checkHashExists, [HASH_ATTRIBUTE_NAME], INVALID_ENVIRONMENT_ERROR, 'invalid env variable');
            test_utils.assertErrorSync(search_util.checkHashExists, [env], HASH_ATTRIBUTE_REQUIRED_ERROR, 'no hash attribute');
            test_utils.assertErrorSync(search_util.checkHashExists, [env, HASH_ATTRIBUTE_NAME], ID_REQUIRED_ERROR, 'no id');
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
            test_utils.assertErrorSync(search_util.searchAll, [], ENV_REQUIRED_ERROR, 'test no args');
            test_utils.assertErrorSync(search_util.searchAll, [HASH_ATTRIBUTE_NAME], INVALID_ENVIRONMENT_ERROR, 'invalid env variable');
            test_utils.assertErrorSync(search_util.searchAll, [env], HASH_ATTRIBUTE_REQUIRED_ERROR, 'no hash attribute');
            test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME], FETCH_ATTRIBUTES_REQUIRED_ERROR, 'no fetch_attributes');
            test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], FETCH_ATTRIBUTES_NOT_ARRAY_ERROR, 'invalid fetch_attributes');
            test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES], undefined, 'all arguments sent');
        });

        it("searchAll rows", ()=>{

            let rows = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES], undefined, 'search');

            assert.deepStrictEqual(rows, [
                {id:1, name:'Kyle', age:46, city:'Denver'},
                {id:2, name:'Jerry', age:32, city:undefined},
                {id:3, name: 'Hank', age: 57, city:undefined},
                {id:4, name:'Joy', age: 44, city:'Denver'}
            ]);
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
            test_utils.assertErrorSync(search_util.countAll, [], ENV_REQUIRED_ERROR, 'test no args');
            test_utils.assertErrorSync(search_util.countAll, [HASH_ATTRIBUTE_NAME], INVALID_ENVIRONMENT_ERROR, 'invalid env variable');
            test_utils.assertErrorSync(search_util.countAll, [env], HASH_ATTRIBUTE_REQUIRED_ERROR, 'no hash attribute');
            test_utils.assertErrorSync(search_util.countAll, [env, HASH_ATTRIBUTE_NAME], undefined, 'all arguments');
        });

        it("test count", () => {
            let count = test_utils.assertErrorSync(search_util.countAll, [env, HASH_ATTRIBUTE_NAME], undefined, 'all arguments');
            assert.deepStrictEqual(count, 4);
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
            test_utils.assertErrorSync(search_util.equals, [], ENV_REQUIRED_ERROR, 'test no args');
            test_utils.assertErrorSync(search_util.equals, [HASH_ATTRIBUTE_NAME], INVALID_ENVIRONMENT_ERROR, 'invalid env variable');
            test_utils.assertErrorSync(search_util.equals, [env], ATTRIBUTE_REQUIRED_ERROR, 'no hash attribute');
            test_utils.assertErrorSync(search_util.equals, [env, 'city'], SEARCH_VALUE_REQUIRED_ERROR, 'no search_value');
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
            let results = test_utils.assertErrorSync(search_util.equals, [env, 'fake', 'bad'], DBI_NO_EXIST_ERROR);
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
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, MULTI_RECORD_ARRAY);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.startsWith, [], ENV_REQUIRED_ERROR, 'test no args');
            test_utils.assertErrorSync(search_util.startsWith, [HASH_ATTRIBUTE_NAME], INVALID_ENVIRONMENT_ERROR, 'invalid env variable');
            test_utils.assertErrorSync(search_util.startsWith, [env], ATTRIBUTE_REQUIRED_ERROR, 'no hash attribute');
            test_utils.assertErrorSync(search_util.startsWith, [env, 'city'], SEARCH_VALUE_REQUIRED_ERROR, 'no search_value');
            test_utils.assertErrorSync(search_util.startsWith, [env, 'city', 'Denver'], undefined, 'all arguments');
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
            let results = test_utils.assertErrorSync(search_util.equals, [env, 'fake', 'bad'], DBI_NO_EXIST_ERROR);
            assert.deepStrictEqual(results, undefined);
        });
    });
});