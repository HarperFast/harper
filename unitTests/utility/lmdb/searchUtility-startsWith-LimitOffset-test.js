'use strict';

const rewire = require('rewire');
const search_util = rewire('../../../utility/lmdb/searchUtility');
const fs = require('fs-extra');
const environment_utility = rewire('../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../utility/lmdb/writeUtility');
const test_utils = require('../../test_utils');
const path = require('path');
const assert = require('assert');
const test_data = require('../../personData.json');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const BASE_TEST_PATH = path.join(test_utils.getMockLMDBPath(), 'lmdbTest');
const TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';

const PERSON_ATTRIBUTES = ['id', 'first_name', 'state', 'age', 'alive', 'birth_month'];
const All_ATTRIBUTES = ['id', 'name', 'age', 'city'];
const TIMESTAMP = Date.now();
const LMDB_TEST_ERRORS = require('../../commonTestErrors').LMDB_ERRORS_ENUM;
const MULTI_RECORD_ARRAY2 = [
    {id:1, name:'Kyle', age:46, city:'Denver'},
    {id:2, name:'Jerry', age:32},
    {id:3, name: 'Hank', age: 57},
    {id:4, name:'Joy', age: 44, city:'Denver'},
    {id:5, name:'Fran', age: 44, city:'Denvertown'},
    {id:6, city:'Nowhere'},
];

describe('test startsWith function', ()=> {
    let env;
    before(async () => {
        global.lmdb_map = undefined;
        await fs.remove(test_utils.getMockLMDBPath());
        await fs.mkdirp(BASE_TEST_PATH);

        env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        await environment_utility.createDBI(env, 'id', false, true);
        await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(All_ATTRIBUTES), MULTI_RECORD_ARRAY2);

        let more_rows = [
            {id:211, mush: 2},
            {id:212, mush: 3},
            {id:213, mush: 22},
            {id:214, mush: 22.2},
            {id:215, mush: '22flavors'},
            {id:215, mush: 'flavors'},
            {id:215, mush: '2flavors'},
            {id:215, mush: '3flavors'},
        ];

        await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ['id', 'mush'], more_rows);
    });

    after(async () => {
        env.close();

        global.lmdb_map = undefined;
        await fs.remove(test_utils.getMockLMDBPath());
    });

    it("test validation", () => {
        test_utils.assertErrorSync(search_util.startsWith, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
        test_utils.assertErrorSync(search_util.startsWith, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
        test_utils.assertErrorSync(search_util.startsWith, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no hash attribute');
        test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'city'], LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED, 'no search_value');
        test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'city', 'D'], undefined, 'all arguments');
    });

    it("test search on city", () => {
        let expected = [[1,4,5],[{"city": "Denver","id": 1},{"city": "Denver","id": 4},{"city": "Denvertown","id": 5}]];

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'city', 'Den'], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 3);
        assert.deepEqual(results[1].length, 3);
        assert.deepEqual(results, expected);
    });

    it("test search on city, no hash", () => {
        let expected = [[1,4,5],[{"city": "Denver"},{"city": "Denver"},{"city": "Denvertown"}]];

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, undefined, 'city', 'Den'], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 3);
        assert.deepEqual(results[1].length, 3);
        assert.deepEqual(results, expected);
    });

    it("test search on city with Denver", () => {
        let expected = [[1,4,5],[{"city": "Denver","id": 1},{"city": "Denver","id": 4},{"city": "Denvertown","id": 5}]];
        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'city', 'Denver'], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 3);
        assert.deepEqual(results[1].length, 3);
        assert.deepEqual(results, expected);
    });

    it("test search on city with Denvert", () => {
        let expected = [[5],[{"city": "Denvertown","id": 5}]];
        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'city', 'Denvert'], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 1);
        assert.deepEqual(results[1].length, 1);
        assert.deepEqual(results, expected);
    });

    it("test search on city with non-existent value", () => {
        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'city', 'FoCo'], undefined, 'all arguments');
        assert.deepStrictEqual(results, [[],[]]);
    });

    it("test search on attribute no exist", () => {
        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id','fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
        assert.deepStrictEqual(results, undefined);
    });

    it("test search on hash attribute", () => {
        let expected = [[1],[{"id": 1}]];
        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id','id', '1'], undefined);
        assert.deepEqual(results[0].length, 1);
        assert.deepEqual(results[1].length, 1);
        assert.deepEqual(results, expected);
    });

    it("test search on mush 2", () => {
        let expected = [[211,213,214,215],[{"mush": 2,"id": 211},{"mush": 22,"id": 213},{"mush": 22.2,"id": 214},{"mush": "22flavors","id": 215}]];

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id','mush', 2], undefined);
        assert.deepEqual(results[0].length, 4);
        assert.deepEqual(results[1].length, 4);
        assert.deepEqual(results, expected);
    });
});

describe('test startsWith function reverse offset limit', ()=> {
    let env;
    let date_stub;
    before(async () => {
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
        global.lmdb_map = undefined;
        await fs.remove(test_utils.getMockLMDBPath());
        await fs.mkdirp(BASE_TEST_PATH);

        env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        await environment_utility.createDBI(env, 'id', false, true);
        await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(PERSON_ATTRIBUTES), test_utils.deepClone(test_data));
    });

    after(async () => {
        date_stub.restore();
        env.close();

        global.lmdb_map = undefined;
        await fs.remove(test_utils.getMockLMDBPath());
    });

    it("test search on first_name limit 20", () => {
        let expected = [[966,884,586,936,880,278,764,17,265,805,62,877,145,739,555,86,777,650,500,882],[{"first_name": "Mara","id": 966},{"first_name": "Marc","id": 884},{"first_name": "Marcellus","id": 586},{"first_name": "Marcia","id": 936},{"first_name": "Marco","id": 880},{"first_name": "Marcus","id": 278},{"first_name": "Margaret","id": 764},{"first_name": "Margarita","id": 17},{"first_name": "Margarita","id": 265},{"first_name": "Margot","id": 805},{"first_name": "Maria","id": 62},{"first_name": "Mariah","id": 877},{"first_name": "Mariano","id": 145},{"first_name": "Maribel","id": 739},{"first_name": "Mariela","id": 555},{"first_name": "Marisol","id": 86},{"first_name": "Marjolaine","id": 777},{"first_name": "Mark","id": 650},{"first_name": "Marlee","id": 500},{"first_name": "Marlin","id": 882}]];

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', false, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 20);
        assert.deepEqual(results[1].length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name offset 20", () => {
        let expected = [[738,563,106,770,156],[{"first_name": "Marques","id": 738},{"first_name": "Marquis","id": 563},{"first_name": "Marquise","id": 106},{"first_name": "Marty","id": 770},{"first_name": "Maryse","id": 156}]];

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', false, undefined, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 5);
        assert.deepEqual(results[1].length, 5);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name offset 10 limit 20", () => {
        let expected = [[62,877,145,739,555,86,777,650,500,882,738,563,106,770,156],[{"first_name": "Maria","id": 62},{"first_name": "Mariah","id": 877},{"first_name": "Mariano","id": 145},{"first_name": "Maribel","id": 739},{"first_name": "Mariela","id": 555},{"first_name": "Marisol","id": 86},{"first_name": "Marjolaine","id": 777},{"first_name": "Mark","id": 650},{"first_name": "Marlee","id": 500},{"first_name": "Marlin","id": 882},{"first_name": "Marques","id": 738},{"first_name": "Marquis","id": 563},{"first_name": "Marquise","id": 106},{"first_name": "Marty","id": 770},{"first_name": "Maryse","id": 156}]];

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', false, 20, 10], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 15);
        assert.deepEqual(results[1].length, 15);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse", () => {
        let expected = [[156,770,106,563,738,882,500,650,777,86,555,739,145,877,62,805,265,17,764,278,880,936,586,884,966],[{"first_name": "Maryse","id": 156},{"first_name": "Marty","id": 770},{"first_name": "Marquise","id": 106},{"first_name": "Marquis","id": 563},{"first_name": "Marques","id": 738},{"first_name": "Marlin","id": 882},{"first_name": "Marlee","id": 500},{"first_name": "Mark","id": 650},{"first_name": "Marjolaine","id": 777},{"first_name": "Marisol","id": 86},{"first_name": "Mariela","id": 555},{"first_name": "Maribel","id": 739},{"first_name": "Mariano","id": 145},{"first_name": "Mariah","id": 877},{"first_name": "Maria","id": 62},{"first_name": "Margot","id": 805},{"first_name": "Margarita","id": 265},{"first_name": "Margarita","id": 17},{"first_name": "Margaret","id": 764},{"first_name": "Marcus","id": 278},{"first_name": "Marco","id": 880},{"first_name": "Marcia","id": 936},{"first_name": "Marcellus","id": 586},{"first_name": "Marc","id": 884},{"first_name": "Mara","id": 966}]];

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', true], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 25);
        assert.deepEqual(results[1].length, 25);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse limit 15", () => {
        let expected = [[156,770,106,563,738,882,500,650,777,86,555,739,145,877,62],[{"first_name": "Maryse","id": 156},{"first_name": "Marty","id": 770},{"first_name": "Marquise","id": 106},{"first_name": "Marquis","id": 563},{"first_name": "Marques","id": 738},{"first_name": "Marlin","id": 882},{"first_name": "Marlee","id": 500},{"first_name": "Mark","id": 650},{"first_name": "Marjolaine","id": 777},{"first_name": "Marisol","id": 86},{"first_name": "Mariela","id": 555},{"first_name": "Maribel","id": 739},{"first_name": "Mariano","id": 145},{"first_name": "Mariah","id": 877},{"first_name": "Maria","id": 62}]];

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', true, 15], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 15);
        assert.deepEqual(results[1].length, 15);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse offset 20", () => {
        let expected = [[880,936,586,884,966],[{"first_name": "Marco","id": 880},{"first_name": "Marcia","id": 936},{"first_name": "Marcellus","id": 586},{"first_name": "Marc","id": 884},{"first_name": "Mara","id": 966}]];

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', true, undefined, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 5);
        assert.deepEqual(results[1].length, 5);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse offset 10 limit 20", () => {
        let expected = [[555,739,145,877,62,805,265,17,764,278,880,936,586,884,966],[{"first_name": "Mariela","id": 555},{"first_name": "Maribel","id": 739},{"first_name": "Mariano","id": 145},{"first_name": "Mariah","id": 877},{"first_name": "Maria","id": 62},{"first_name": "Margot","id": 805},{"first_name": "Margarita","id": 265},{"first_name": "Margarita","id": 17},{"first_name": "Margaret","id": 764},{"first_name": "Marcus","id": 278},{"first_name": "Marco","id": 880},{"first_name": "Marcia","id": 936},{"first_name": "Marcellus","id": 586},{"first_name": "Marc","id": 884},{"first_name": "Mara","id": 966}]];

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', true, 20, 10], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 15);
        assert.deepEqual(results[1].length, 15);
        assert.deepEqual(results, expected);
    });
});