"use strict";

const delete_utility = require('../../../utility/lmdb/deleteUtility');
const search_util = require('../../../utility/lmdb/searchUtility');
const fs = require('fs-extra');
const environment_utility = require('../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../utility/lmdb/writeUtility');
const test_utils = require('../../test_utils');
const path = require('path');
const assert = require('assert');
const LMDB_TEST_ERRORS = require('../../commonTestErrors').LMDB_ERRORS_ENUM;

const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'lmdbTest');
const TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';
const SOME_ATTRIBUTES = ['id', 'name', 'age'];
const All_ATTRIBUTES = ['id', 'name', 'age', 'city'];

const MULTI_RECORD_ARRAY = [
    {id:1, name:'Kyle', age:46, city:'Denver'},
    {id:2, name:'Jerry', age:32},
    {id:3, name: 'Hank', age: 57},
    {id:4, name:'Joy', age: 44, city:'Denver'},
    {id:5, name:'Fran', age: 44, city:'Denvertown'},
];

const MULTI_RECORD_ARRAY_COMPARE = [
    {id:1, name:'Kyle', age:46, city:'Denver'},
    {id:2, name:'Jerry', age:32, city:undefined},
    {id:3, name: 'Hank', age: 57, city:undefined},
    {id:4, name:'Joy', age: 44, city:'Denver'},
    {id:5, name:'Fran', age: 44, city:'Denvertown'},
];

const IDS = ['1', '2', '3', '4', '5'];

describe('Test deleteUtility', ()=>{
    let env;
    beforeEach(async ()=>{
        await fs.mkdirp(BASE_TEST_PATH);
        global.lmdb_map = undefined;
        env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        await environment_utility.createDBI(env, HASH_ATTRIBUTE_NAME);
        write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, MULTI_RECORD_ARRAY);
    });

    afterEach(async ()=>{
        await fs.remove(BASE_TEST_PATH);
        global.lmdb_map = undefined;
    });

    describe('Test deleteRecords function', ()=>{
        it('test validation', ()=>{
            test_utils.assertErrorSync(delete_utility.deleteRecords, [], LMDB_TEST_ERRORS.ENV_REQUIRED);
            test_utils.assertErrorSync(delete_utility.deleteRecords, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT);
            test_utils.assertErrorSync(delete_utility.deleteRecords, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED);
            test_utils.assertErrorSync(delete_utility.deleteRecords, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.IDS_REQUIRED);
            test_utils.assertErrorSync(delete_utility.deleteRecords, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.IDS_MUST_BE_ARRAY);
            test_utils.assertErrorSync(delete_utility.deleteRecords, [env, HASH_ATTRIBUTE_NAME, []], undefined);
        });

        it('delete all records', ()=>{
            let records = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, IDS], undefined);
            assert.deepStrictEqual(records, MULTI_RECORD_ARRAY_COMPARE);

            test_utils.assertErrorSync(delete_utility.deleteRecords, [env, HASH_ATTRIBUTE_NAME, IDS], undefined);

            //assert all indices have been cleared
            records = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, IDS], undefined);
            assert.deepStrictEqual(records, []);

            All_ATTRIBUTES.forEach(attribute=>{
                let results = test_utils.assertErrorSync(search_util.iterateDBI, [env, attribute], undefined, 'city iterate');
                assert.deepStrictEqual(results, []);
            });
        });

        it('delete some records', ()=>{
            let some_ids = ['2', '4'];
            let some_record_compare = [
                {
                    "age": 32,
                    "city": undefined,
                    "id": 2,
                    "name": "Jerry",
                },
                {
                    "age": 44,
                    "city": "Denver",
                    "id": 4,
                    "name": "Joy"
                }
            ];

            let records = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, some_ids], undefined);
            assert.deepStrictEqual(records, some_record_compare);

            test_utils.assertErrorSync(delete_utility.deleteRecords, [env, HASH_ATTRIBUTE_NAME, some_ids], undefined);

            //assert can't find the rows
            records = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, some_ids], undefined);
            assert.deepStrictEqual(records, []);

            //assert indices don't have deleted record entries
            let results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'age'], undefined, 'age iterate');
            assert.deepStrictEqual(results, [ [ '44', '5' ], [ '46', '1' ], [ '57', '3' ] ]);

            results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'city'], undefined, 'age iterate');
            assert.deepStrictEqual(results, [ [ 'Denver', '1' ], [ 'Denvertown', '5' ] ]);

            results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'name'], undefined, 'age iterate');
            assert.deepStrictEqual(results, [ [ 'Fran', '5' ], [ 'Hank', '3' ], [ 'Kyle', '1' ] ]);
        });
    });
});