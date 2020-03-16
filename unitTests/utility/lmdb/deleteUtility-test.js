"use strict";

const rewire = require('rewire');
const delete_utility = require('../../../utility/lmdb/deleteUtility');
const search_util = require('../../../utility/lmdb/searchUtility');
const fs = require('fs-extra');
const environment_utility = rewire('../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../utility/lmdb/writeUtility');
const test_utils = require('../../test_utils');
const path = require('path');
const assert = require('assert');
const LMDB_TEST_ERRORS = require('../../commonTestErrors').LMDB_ERRORS_ENUM;

const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'lmdbTest');
const TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';
const All_ATTRIBUTES = ['id', 'name', 'age', 'city'];

const MULTI_RECORD_ARRAY = [
    {id:1, name:'Kyle', age:46, city:'Denver'},
    {id:2, name:'Jerry', age:32},
    {id:3, name: 'Hank', age: 57},
    {id:4, name:'Joy', age: 44, city:'Denver'},
    {id:5, name:'Fran', age: 44, city:'Denvertown'},
    {
        id: 6,
        text: 'Occupy messenger bag microdosing yr, kale chips neutra la croix VHS ugh wayfarers street art. Ethical cronut whatever, cold-pressed viral post-ironic man bun swag marfa green juice. Knausgaard gluten-free selvage ethical subway tile sartorial man bun butcher selfies raclette paleo. Fam brunch plaid woke authentic dreamcatcher hot chicken quinoa gochujang slow-carb selfies keytar PBR&B street art pinterest. Narwhal tote bag glossier paleo cronut salvia cloud bread craft beer butcher meditation fingerstache hella migas 8-bit messenger bag. Tattooed schlitz palo santo gluten-free, wayfarers tumeric squid. Hella keytar thundercats chambray, occupy iPhone paleo slow-carb jianbing everyday carry 90\'s distillery polaroid fanny pack. Kombucha cray PBR&B shoreditch 8-bit, adaptogen vinyl swag meditation 3 wolf moon. Selvage art party retro kitsch pour-over iPhone street art celiac etsy cred cliche gastropub. Kombucha migas marfa listicle cliche. Godard kombucha ennui lumbersexual, austin pop-up raclette retro. Man braid kale chips pitchfork, tote bag hoodie poke mumblecore. Bitters shoreditch tbh everyday carry keffiyeh raw denim kale chips.'
    }
];

const MULTI_RECORD_ARRAY_COMPARE = [
    {id:1, name:'Kyle', age:46, city:'Denver'},
    {id:2, name:'Jerry', age:32, city:null},
    {id:3, name: 'Hank', age: 57, city:null},
    {id:4, name:'Joy', age: 44, city:'Denver'},
    {id:5, name:'Fran', age: 44, city:'Denvertown'},
    {
        id: 6,
        name:null, age: null, city:null
    }
];

const IDS = ['1', '2', '3', '4', '5', '6'];

describe('Test deleteUtility', ()=>{
    let env;
    let rw_env_util;
    before(()=>{
        rw_env_util = environment_utility.__set__('MAP_SIZE', 10*1024*1024*1024);
    });

    after(()=>{
        rw_env_util();
    });

    beforeEach(async ()=>{
        await fs.mkdirp(BASE_TEST_PATH);
        global.lmdb_map = undefined;
        env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        await environment_utility.createDBI(env, HASH_ATTRIBUTE_NAME, false);
        await environment_utility.createDBI(env, '__blob__', false);
        write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(All_ATTRIBUTES), MULTI_RECORD_ARRAY);
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
            let expected_compare = Object.create(null);
            MULTI_RECORD_ARRAY_COMPARE.forEach(compare=>{
                expected_compare[compare.id.toString()] = test_utils.assignObjecttoNullObject(compare);
            });

            let records = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, IDS], undefined);
            assert.deepEqual(records, expected_compare);

            test_utils.assertErrorSync(delete_utility.deleteRecords, [env, HASH_ATTRIBUTE_NAME, IDS], undefined);

            //assert all indices have been cleared
            records = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, IDS], undefined);
            assert.deepStrictEqual(records, {});

            All_ATTRIBUTES.forEach(attribute=>{
                let results = test_utils.assertErrorSync(search_util.iterateDBI, [env, attribute], undefined, 'city iterate');
                assert.deepStrictEqual(results, Object.create(null));
            });
        });

        it('delete some records', ()=>{
            let some_ids = ['2', '4'];
            let some_record_compare = {"2":
                test_utils.assignObjecttoNullObject({
                    "age": 32,
                    "city": null,
                    "id": 2,
                    "name": "Jerry",
                }),"4":
                test_utils.assignObjecttoNullObject({
                    "age": 44,
                    "city": "Denver",
                    "id": 4,
                    "name": "Joy"
                })
            };

            let records = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, some_ids], undefined);
            assert.deepStrictEqual(records, some_record_compare);

            test_utils.assertErrorSync(delete_utility.deleteRecords, [env, HASH_ATTRIBUTE_NAME, some_ids], undefined);

            //assert can't find the rows
            records = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, some_ids], undefined);
            assert.deepStrictEqual(records, {});

            //assert indices don't have deleted record entries
            let iterate_results = {'44': ['5'], '46': ['1'], '57': ['3']};
            let results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'age'], undefined, 'age iterate');
            assert.deepEqual(results, iterate_results);

            iterate_results = {'Denver': ['1'], 'Denvertown': ['5']};
            results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'city'], undefined, 'age iterate');
            assert.deepEqual(results, iterate_results);

            iterate_results = {'Fran': ['5'], 'Hank': ['3'], 'Kyle': ['1']};
            results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'name'], undefined, 'age iterate');
            assert.deepEqual(results, iterate_results);
        });

        it('delete record with long text', ()=>{
            let some_ids = ['6'];
            let record = test_utils.deepClone(MULTI_RECORD_ARRAY[5]);
            delete record.__updatedtime__;
            delete record.__createdtime__;
            let some_record_compare = {
                [record.id]: test_utils.assignObjecttoNullObject(record)
            };

            let records = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, ['id', 'text'], some_ids], undefined);
            assert.deepEqual(records, some_record_compare);

            test_utils.assertErrorSync(delete_utility.deleteRecords, [env, HASH_ATTRIBUTE_NAME, some_ids], undefined);

            //assert can't find the rows
            records = test_utils.assertErrorSync(search_util.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, All_ATTRIBUTES, some_ids], undefined);
            assert.deepStrictEqual(records, {});

            //assert indices don't have deleted record entries
            let iterate_results = {'32': ['2'], '44': ['4', '5' ], '46': ['1'], '57': ['3']};
            let results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'age'], undefined, 'age iterate');
            assert.deepEqual(results, iterate_results);

            iterate_results = {'Denver': ['1', '4'], 'Denvertown': ['5']};
            results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'city'], undefined, 'city iterate');
            assert.deepEqual(results, iterate_results);

            iterate_results = {'Fran': ['5'], 'Hank': ['3'], 'Jerry': ['2'], 'Joy': ['4'], 'Kyle': ['1']};
            results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'name'], undefined, 'name iterate');
            assert.deepEqual(results, iterate_results);

            results = test_utils.assertErrorSync(search_util.iterateDBI, [env, '__blob__'], undefined, 'name iterate');
            assert.deepStrictEqual(results, Object.create(null));
        });
    });
});