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
const common_utils = require('../../../utility/common_utils');
const sinon = require('sinon');
const uuid = require('uuid/v4');
const sandbox = sinon.createSandbox();
const BASE_TEST_PATH = path.join(test_utils.getMockLMDBPath(), 'lmdbTest');
let TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';
const SOME_ATTRIBUTES = ['id', 'name', 'age'];
const All_ATTRIBUTES = ['id', 'name', 'age', 'city'];

const MULTI_RECORD_ARRAY = [
    {id:1, name:'Kyle', age:46, city:'Denver'},
    {id:2, name:'Jerry', age:32},
    {id:3, name: 'Hank', age: 57},
    {id:4, name:'Joy', age: 44, city:'Denver'}
];

let denver_but_longer = 'Denver';
for (let i = 0; i < 100; i++) {
    denver_but_longer += ' and more text'
}

const MULTI_RECORD_ARRAY2 = [
    {id:1, name:'Kyle', age:46, city:['Athens', 'Denver']},
    {id:2, name:'Jerry', age:32},
    {id:3, name: 'Hank', age: 57},
    {id:4, name:'Joy', age: 44, city:'Denver'},
    {id:5, name:'Fran', age: 44, city: denver_but_longer},
    {id:6, city:'Nowhere'},
];

const TIMESTAMP = Date.now();

describe('Test searchUtility module', ()=>{
    let date_stub;
    before(()=> {

        test_data.forEach(record=>{
            Object.keys(record).forEach(key=>{
                record[key] = common_utils.autoCast(record[key]);
            });
        });

        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
    });

    after(()=> {
        date_stub.restore();
    });

    describe('test searchByHash function', ()=>{
        let env;
        before(async ()=>{
            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
            await fs.mkdirp(BASE_TEST_PATH);
            TEST_ENVIRONMENT_NAME = uuid();
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, true);
            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(All_ATTRIBUTES), MULTI_RECORD_ARRAY);
        });

        after(async ()=>{
            await env.close();
            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
        });

        it("test validation", ()=>{
            test_utils.assertErrorSync(search_util.searchByHash, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.searchByHash, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.searchByHash, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_REQUIRED, 'no fetch_attributes');
            test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_MUST_BE_ARRAY, 'invalid fetch_attributes');
            test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES], LMDB_TEST_ERRORS.ID_REQUIRED, 'no id');
            test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, MULTI_RECORD_ARRAY[0][HASH_ATTRIBUTE_NAME].toString()],
                undefined, 'all arguments sent');
        });

        it("test select all attributes *", ()=>{
            let record = test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, ['*'], 3],
                undefined, 'all arguments sent');
            let expected = test_utils.assignObjecttoNullObject({"age": 57, city: null, "id": 3, "name": "Hank", __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP});
            assert.deepStrictEqual(record, expected);
        });

        it("test select some attributes", ()=>{
            let record = test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, 3],
                undefined, 'all arguments sent');

            assert.deepStrictEqual(record, test_utils.assignObjecttoNullObject({"age": 57, "id": 3, "name": "Hank"}));
        });

        it("test select record no exist", ()=>{
            let record = test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, 33],
                undefined, 'all arguments sent');

            assert.deepStrictEqual(record, null);
        });

        it("test select record only id & name", ()=>{
            let record = test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, ["id", "name"], 2],
                undefined, 'all arguments sent');

            assert.deepStrictEqual(record, test_utils.assignObjecttoNullObject({id:2, name:"Jerry"}));
        });

        it("test select record only id & name and non-exsitent attribute", ()=>{
            let record = test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, ["id", "name", "dob"], 2],
                undefined, 'all arguments sent');

            assert.deepStrictEqual(record, test_utils.assignObjecttoNullObject({id:2, name:"Jerry", dob:null}));
        });
    });

    describe("Test batchSearchByHash", ()=>{
        let env;
        before(async ()=>{
            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
            await fs.mkdirp(BASE_TEST_PATH);
            TEST_ENVIRONMENT_NAME = uuid();
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(All_ATTRIBUTES), MULTI_RECORD_ARRAY);
        });

        after(async ()=>{
            await env.close();
            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
        });

        it("test validation", ()=>{
            test_utils.assertErrorSync(search_util.batchSearchByHash, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_REQUIRED, 'no fetch_attributes');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_MUST_BE_ARRAY, 'invalid fetch_attributes');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES], LMDB_TEST_ERRORS.IDS_REQUIRED, 'no id');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, 1],
                LMDB_TEST_ERRORS.IDS_MUST_BE_ARRAY, 'invalid ids');
            test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, [1, 3, 2]],
                undefined, 'all correct arguments');
        });

        it("test fetch single record", ()=>{
            let expected = {id:1, name:'Kyle', age:46};
            let row = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, [1]],
                undefined, 'fetch single row');
            assert.deepEqual(row, [expected]);
        });

        it("test fetch multiple records", ()=>{
            let expected = [{id:1, name:'Kyle', age:46},
                {id:2, name:'Jerry', age:32},
                {id:4, name:'Joy', age: 44}
                ];
            let row = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, [1, 4, 2]],
                undefined, 'fetch multi rows');

            assert.deepEqual(row, expected);
        });

        it("test fetch multiple records, all attributes", ()=>{
            let expected = [{id:1, name:'Kyle', age:46, city: "Denver", __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP},
                {id:2, name:'Jerry', age:32, city: null, __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP},
                {id:4, name:'Joy', age: 44, city: "Denver", __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP}
            ];
            let row = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, ['*'], [1, 4, 2]],
                undefined, 'fetch multi rows');

            assert.deepEqual(row, expected);
        });

        it("test fetch multiple records some don't exist", ()=>{
            let expected = [{id:1, name:'Kyle', age:46},
                {id:2, name:'Jerry', age:32},
                {id:4, name:'Joy', age: 44}];

            let row = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, [1,"fake", 4, 55, 2]],
                undefined, 'fetch single row');

            assert.deepEqual(row, expected);
        });
    });

    describe("Test batchSearchByHashToMap", ()=>{
        let env;
        before(async ()=>{
            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
            await fs.mkdirp(BASE_TEST_PATH);
            TEST_ENVIRONMENT_NAME = uuid();
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(SOME_ATTRIBUTES), MULTI_RECORD_ARRAY);
        });

        after(async ()=>{
            await env.close();

            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
        });

        it("test validation", ()=>{
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_REQUIRED, 'no fetch_attributes');
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.FETCH_ATTRIBUTES_MUST_BE_ARRAY, 'invalid fetch_attributes');
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES], LMDB_TEST_ERRORS.IDS_REQUIRED, 'no id');
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, 1],
                LMDB_TEST_ERRORS.IDS_MUST_BE_ARRAY, 'invalid ids');
            test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, [1, 3, 2]],
                undefined, 'all correct arguments');
        });

        it("test fetch single record", ()=>{
            let row = test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, [1]],
                undefined, 'fetch single row');

            assert.deepStrictEqual(row, test_utils.assignObjecttoNullObject({1: test_utils.assignObjecttoNullObject({id:1, name:'Kyle', age:46})}));
        });

        it("test fetch multiple records", ()=>{
            let row = test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, [1, 4, 2]],
                undefined, 'fetch multi rows');

            let expected = test_utils.assignObjecttoNullObject({1: test_utils.assignObjecttoNullObject({id:1, name:'Kyle', age:46}),
                2: test_utils.assignObjecttoNullObject({id:2, name:'Jerry', age:32}),
                4: test_utils.assignObjecttoNullObject({id:4, name:'Joy', age: 44})
            });

            assert.deepStrictEqual(row, expected);
        });

        it("test fetch multiple records some don't exist", ()=>{
            let row = test_utils.assertErrorSync(search_util.batchSearchByHashToMap, [env, HASH_ATTRIBUTE_NAME, SOME_ATTRIBUTES, [1,"fake", 4, 55, 2]],
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
            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
            await fs.mkdirp(BASE_TEST_PATH);
            TEST_ENVIRONMENT_NAME = uuid();
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(SOME_ATTRIBUTES), MULTI_RECORD_ARRAY);
        });

        after(async () => {
            await env.close();

            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.checkHashExists, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.checkHashExists, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.checkHashExists, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.checkHashExists, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.ID_REQUIRED, 'no id');
            test_utils.assertErrorSync(search_util.checkHashExists, [env, HASH_ATTRIBUTE_NAME, 1],
                undefined, 'all correct arguments');
        });

        it("test key exists", ()=>{
            let exists = test_utils.assertErrorSync(search_util.checkHashExists, [env, HASH_ATTRIBUTE_NAME, 1],
                undefined, 'all correct arguments');

            assert.deepStrictEqual(exists, true, "hash exists");
        });

        it("test key does not exists", ()=>{
            let exists = test_utils.assertErrorSync(search_util.checkHashExists, [env, HASH_ATTRIBUTE_NAME, 111],
                undefined, 'all correct arguments');

            assert.deepStrictEqual(exists, false, "hash exists");
        });
    });

    describe('test searchAll function', ()=> {
        let env;
        before(async () => {
            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
            await fs.mkdirp(BASE_TEST_PATH);
            TEST_ENVIRONMENT_NAME = uuid();
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(All_ATTRIBUTES), MULTI_RECORD_ARRAY);
        });

        after(async () => {
            await env.close();

            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
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

            let expected = [
                {id: 1, name: 'Kyle', age: 46, city: 'Denver'},
                {id: 2, name: 'Jerry', age: 32, city: null},
                {id: 3, name: 'Hank', age: 57, city: null},
                {id: 4, name: 'Joy', age: 44, city: 'Denver'}];
            assert.deepEqual(rows, expected);
        });

        it("searchAll rows, attributes ['*']", ()=>{
            let rows = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ['*']], undefined, 'search');

            let expected = [
                {id: 1, name: 'Kyle', age: 46, city: 'Denver', __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP},
                {id: 2, name: 'Jerry', age: 32, city: null, __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP},
                {id: 3, name: 'Hank', age: 57, city: null, __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP},
                {id: 4, name: 'Joy', age: 44, city: 'Denver', __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP}];
            assert.deepEqual(rows, expected);
        });
    });

    describe('test searchAllToMap function', ()=> {
        let env;
        before(async () => {
            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
            await fs.mkdirp(BASE_TEST_PATH);
            TEST_ENVIRONMENT_NAME = uuid();
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(SOME_ATTRIBUTES), MULTI_RECORD_ARRAY);
        });

        after(async () => {
            await env.close();

            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
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
            expected['2'] = test_utils.assignObjecttoNullObject({id:2, name:'Jerry', age:32, city:null});
            expected['3'] = test_utils.assignObjecttoNullObject({id:3, name: 'Hank', age: 57, city:null});
            expected['4'] = test_utils.assignObjecttoNullObject({id:4, name:'Joy', age: 44, city:'Denver'});
            assert.deepStrictEqual(rows, expected);
        });
    });

    describe('test countAll function', ()=> {
        let env;
        before(async () => {
            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
            await fs.mkdirp(BASE_TEST_PATH);
            TEST_ENVIRONMENT_NAME = uuid();
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, true);
            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(SOME_ATTRIBUTES), MULTI_RECORD_ARRAY);
        });

        after(async () => {
            await env.close();

            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
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
    describe('test iterateDBI and freeze function', () => {
        let env;
        before(async () => {
            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
            await fs.mkdirp(BASE_TEST_PATH);
            TEST_ENVIRONMENT_NAME = uuid();
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, true);
            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(All_ATTRIBUTES), MULTI_RECORD_ARRAY2);
        });

        after(async () => {
            await env.close();

            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockLMDBPath());
        });

        it("test validation", () => {
            test_utils.assertErrorSync(search_util.iterateDBI, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
            test_utils.assertErrorSync(search_util.iterateDBI, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
            test_utils.assertErrorSync(search_util.iterateDBI, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no hash attribute');
            test_utils.assertErrorSync(search_util.iterateDBI, [env,'city'], undefined, 'no search_value');
        });

        it("test iterate on city", () => {
            let results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'city'], undefined, 'city iterate');
            assert.deepEqual(results, {
                'Athens': [1],
                'Denver': [1, 4],
                [denver_but_longer]: [5],
                'Nowhere': [6],
            });
        });

        it("test search on attribute no exist", () => {
            let results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'fake'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            assert.deepStrictEqual(results, undefined);
        });
        it("test nested object in searchByHash is frozen", () => {
            env.dbis.id.cache.clear(); // reload to ensure read data is frozen
            let results = search_util.searchByHash(env, 'id', ['id', 'city'], 1);
            assert(Object.isFrozen(results.city));
        });
        it("test nested object in equals is frozen", () => {
            let results = search_util.equals(env, 'id', 'id', 1);
            assert(Object.isFrozen(results[0].city));
        });
    });
});