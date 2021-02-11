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
const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'lmdbTest');
const TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';

const PERSON_ATTRIBUTES = ['id', 'first_name', 'state', 'age', 'alive', 'birth_month'];
const All_ATTRIBUTES = ['id', 'name', 'age', 'city'];
const LMDB_TEST_ERRORS = require('../../commonTestErrors').LMDB_ERRORS_ENUM;

const MULTI_RECORD_ARRAY = [
    {id:1, name:'Kyle', age:46, city:'Denver'},
    {id:2, name:'Jerry', age:32},
    {id:3, name: 'Hank', age: 57},
    {id:4, name:'Joy', age: 44, city:'Denver'}
];

const TIMESTAMP = Date.now();

describe('test equals function', ()=> {
    let env;
    before(async () => {
        await fs.mkdirp(BASE_TEST_PATH);
        global.lmdb_map = undefined;
        env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        await environment_utility.createDBI(env, 'id', false, true);
        await environment_utility.createDBI(env, 'age', true, false);
        await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(All_ATTRIBUTES), MULTI_RECORD_ARRAY);
    });

    after(async () => {
        env.close();
        await fs.remove(BASE_TEST_PATH);
        global.lmdb_map = undefined;
    });

    it("test validation", () => {
        test_utils.assertErrorSync(search_util.equals, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
        test_utils.assertErrorSync(search_util.equals, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
        test_utils.assertErrorSync(search_util.equals, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no hash attribute');
        test_utils.assertErrorSync(search_util.equals, [env, 'id', 'city'], LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED, 'no search_value');
        test_utils.assertErrorSync(search_util.equals, [env, 'id', 'city', 'Denver'], undefined, 'all arguments');
    });

    it("test search on city", () => {
        let expected = [[1,4],[{"city": "Denver","id": 1},{"city": "Denver","id": 4}]];

        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'city', 'Denver'], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 2);
        assert.deepEqual(results[1].length, 2);
        assert.deepEqual(results, expected);
    });

    it("test search on city, no hash", () => {
        let expected = [[1,4],[{"city": "Denver"},{"city": "Denver"}]];
        let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'city', 'Denver'], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 2);
        assert.deepEqual(results[1].length, 2);
        assert.deepEqual(results, expected);
    });

    it("test search on city with only partial value", () => {
        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'city', 'Den'], undefined, 'all arguments');
        assert.deepStrictEqual(results, [[],[]]);
    });

    it("test search on attribute no exist", () => {
        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
        assert.deepStrictEqual(results, undefined);
    });

    it("test search on age (number attribute)", () => {
        let expected = [[1],[{"age": 46,"id": 1}]];

        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'age', 46], undefined);
        assert.deepEqual(results[0].length, 1);
        assert.deepEqual(results[1].length, 1);
        assert.deepEqual(results, expected);
    });

    it("test search on age (number attribute) value doesn't exist", () => {
        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'age', 100], undefined);
        assert.deepStrictEqual(results, [[],[]]);
    });

    it("test search on hash attribute (id)", () => {
        let expected = [[1],[{"id": 1}]];
        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id','id', 1], undefined);
        assert.deepEqual(results[0].length, 1);
        assert.deepEqual(results[1].length, 1);
        assert.deepEqual(results, expected);
    });

    it("test search on hash attribute (id), value doesn't exist", () => {
        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'id', 10000], undefined);
        assert.deepStrictEqual(results, [[],[]]);
    });
});

describe('test equals function reverse limit offset', ()=> {
    let env;
    let date_stub;
    before(async () => {
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
        await fs.mkdirp(BASE_TEST_PATH);
        global.lmdb_map = undefined;
        env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        await environment_utility.createDBI(env, 'id', false, true);
        await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(PERSON_ATTRIBUTES), test_utils.deepClone(test_data));
    });

    after(async () => {
        date_stub.restore();
        env.close();
        await fs.remove(BASE_TEST_PATH);
        global.lmdb_map = undefined;
    });

    it("test search on state limit 10", () => {
        let expected = [[58,60,83,88,172,224,229,330,384,418],[{"state": "CO","id": 58},{"state": "CO","id": 60},{"state": "CO","id": 83},{"state": "CO","id": 88},{"state": "CO","id": 172},{"state": "CO","id": 224},{"state": "CO","id": 229},{"state": "CO","id": 330},{"state": "CO","id": 384},{"state": "CO","id": 418}]];

        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'state', 'CO', false, 10], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 10);
        assert.deepEqual(results[1].length, 10);
        assert.deepEqual(results, expected);
    });

    it("test search on state offset 10", () => {
        let expected = [[481,521,611,644,658,701,943,946,967],[{"state": "CO","id": 481},{"state": "CO","id": 521},{"state": "CO","id": 611},{"state": "CO","id": 644},{"state": "CO","id": 658},{"state": "CO","id": 701},{"state": "CO","id": 943},{"state": "CO","id": 946},{"state": "CO","id": 967}]];

        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'state', 'CO', false, undefined, 10], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 9);
        assert.deepEqual(results[1].length, 9);
        assert.deepEqual(results, expected);
    });

    it("test search on state, limit 1000", () => {
        let expected = [[58,60,83,88,172,224,229,330,384,418,481,521,611,644,658,701,943,946,967],[{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"}]];

        let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', false, 1000], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 19);
        assert.deepEqual(results[1].length, 19);
        assert.deepEqual(results, expected);
    });

    it("test search on state, offset 10 limit 5", () => {
        let expected = [[481,521,611,644,658],[{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"}]];

        let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', false, 5, 10], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 5);
        assert.deepEqual(results[1].length, 5);
        assert.deepEqual(results, expected);
    });

    it("test search on state, offset 1000 limit 5", () => {
        let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', false, 5, 1000], undefined, 'all arguments');
        assert.deepEqual(results, [[],[]]);
    });

    it("test search on state reverse", () => {
        let expected = [[967,946,943,701,658,644,611,521,481,418,384,330,229,224,172,88,83,60,58],[{"state": "CO","id": 967},{"state": "CO","id": 946},{"state": "CO","id": 943},{"state": "CO","id": 701},{"state": "CO","id": 658},{"state": "CO","id": 644},{"state": "CO","id": 611},{"state": "CO","id": 521},{"state": "CO","id": 481},{"state": "CO","id": 418},{"state": "CO","id": 384},{"state": "CO","id": 330},{"state": "CO","id": 229},{"state": "CO","id": 224},{"state": "CO","id": 172},{"state": "CO","id": 88},{"state": "CO","id": 83},{"state": "CO","id": 60},{"state": "CO","id": 58}]];

        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'state', 'CO', true], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 19);
        assert.deepEqual(results[1].length, 19);
        assert.deepEqual(results, expected);
    });

    it("test search on state reverse limit 10", () => {
        let expected = [[967,946,943,701,658,644,611,521,481,418],[{"state": "CO","id": 967},{"state": "CO","id": 946},{"state": "CO","id": 943},{"state": "CO","id": 701},{"state": "CO","id": 658},{"state": "CO","id": 644},{"state": "CO","id": 611},{"state": "CO","id": 521},{"state": "CO","id": 481},{"state": "CO","id": 418}]];

        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'state', 'CO', true, 10], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 10);
        assert.deepEqual(results[1].length, 10);
        assert.deepEqual(results, expected);
    });

    it("test search on state reverse offset 10", () => {
        let expected = [[384,330,229,224,172,88,83,60,58],[{"state": "CO","id": 384},{"state": "CO","id": 330},{"state": "CO","id": 229},{"state": "CO","id": 224},{"state": "CO","id": 172},{"state": "CO","id": 88},{"state": "CO","id": 83},{"state": "CO","id": 60},{"state": "CO","id": 58}]];

        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'state', 'CO', true, undefined, 10], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 9);
        assert.deepEqual(results[1].length, 9);
        assert.deepEqual(results, expected);
    });

    it("test search on state, reverse, limit 1000", () => {
        let expected = [[967,946,943,701,658,644,611,521,481,418,384,330,229,224,172,88,83,60,58],[{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"}]];

        let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', true, 1000], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 19);
        assert.deepEqual(results[1].length, 19);
        assert.deepEqual(results, expected);
    });

    it("test search on state, reverse offset 10 limit 5", () => {
        let expected = [[384,330,229,224,172],[{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"},{"state": "CO"}]];

        let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', true, 5, 10], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 5);
        assert.deepEqual(results[1].length, 5);
        assert.deepEqual(results, expected);
    });

    it("test search on state, reverse offset 1000 limit 5", () => {
        let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', true, 5, 1000], undefined, 'all arguments');
        assert.deepEqual(results, [[],[]]);
    });
});