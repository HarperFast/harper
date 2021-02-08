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

const TIMESTAMP = Date.now();

describe('test endsWith function', ()=> {
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

    it("test search on first_name limit 10", () => {
        let expected = { "19": { "first_name": "Delphia", "id": 19 }, "62": { "first_name": "Maria", "id": 62 }, "151": { "first_name": "Sofia", "id": 151 }, "186": { "first_name": "Thalia", "id": 186 }, "268": { "first_name": "Gia", "id": 268 }, "270": { "first_name": "Alexandria", "id": 270 }, "301": { "first_name": "Emilia", "id": 301 }, "314": { "first_name": "Theresia", "id": 314 }, "425": { "first_name": "Lelia", "id": 425 }, "450": { "first_name": "Shania", "id": 450 } };
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', false, 10], undefined, 'all arguments');
        assert.deepEqual(Object.keys(results).length, 10);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name limit 10 offset 10", () => {
        let expected = { "467": { "first_name": "Zaria", "id": 467 }, "508": { "first_name": "Thalia", "id": 508 }, "538": { "first_name": "Delia", "id": 538 }, "545": { "first_name": "Alia", "id": 545 }, "621": { "first_name": "Cecilia", "id": 621 }, "625": { "first_name": "Estefania", "id": 625 }, "669": { "first_name": "Adelia", "id": 669 }, "685": { "first_name": "Gregoria", "id": 685 }, "692": { "first_name": "Otilia", "id": 692 }, "795": { "first_name": "Dahlia", "id": 795 } };
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', false, 10, 10], undefined, 'all arguments');
        assert.deepEqual(Object.keys(results).length, 10);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse", () => {
        let expected = { "19": { "first_name": "Delphia", "id": 19 }, "62": { "first_name": "Maria", "id": 62 }, "151": { "first_name": "Sofia", "id": 151 }, "186": { "first_name": "Thalia", "id": 186 }, "268": { "first_name": "Gia", "id": 268 }, "270": { "first_name": "Alexandria", "id": 270 }, "301": { "first_name": "Emilia", "id": 301 }, "314": { "first_name": "Theresia", "id": 314 }, "425": { "first_name": "Lelia", "id": 425 }, "450": { "first_name": "Shania", "id": 450 }, "467": { "first_name": "Zaria", "id": 467 }, "508": { "first_name": "Thalia", "id": 508 }, "538": { "first_name": "Delia", "id": 538 }, "545": { "first_name": "Alia", "id": 545 }, "621": { "first_name": "Cecilia", "id": 621 }, "625": { "first_name": "Estefania", "id": 625 }, "669": { "first_name": "Adelia", "id": 669 }, "685": { "first_name": "Gregoria", "id": 685 }, "692": { "first_name": "Otilia", "id": 692 }, "795": { "first_name": "Dahlia", "id": 795 }, "871": { "first_name": "Magnolia", "id": 871 }, "876": { "first_name": "Bria", "id": 876 }, "898": { "first_name": "Asia", "id": 898 }, "901": { "first_name": "Trycia", "id": 901 }, "922": { "first_name": "Thalia", "id": 922 }, "936": { "first_name": "Marcia", "id": 936 }, "968": { "first_name": "Eugenia", "id": 968 } };
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', true], undefined, 'all arguments');
        assert.deepEqual(Object.keys(results).length, 27);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse limit 10", () => {
        let expected = { "685": { "first_name": "Gregoria", "id": 685 }, "692": { "first_name": "Otilia", "id": 692 }, "795": { "first_name": "Dahlia", "id": 795 }, "871": { "first_name": "Magnolia", "id": 871 }, "876": { "first_name": "Bria", "id": 876 }, "898": { "first_name": "Asia", "id": 898 }, "901": { "first_name": "Trycia", "id": 901 }, "922": { "first_name": "Thalia", "id": 922 }, "936": { "first_name": "Marcia", "id": 936 }, "968": { "first_name": "Eugenia", "id": 968 } };
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', true, 10], undefined, 'all arguments');
        assert.deepEqual(Object.keys(results).length, 10);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse offset 10", () => {
        let expected = { "19": { "first_name": "Delphia", "id": 19 }, "62": { "first_name": "Maria", "id": 62 }, "151": { "first_name": "Sofia", "id": 151 }, "186": { "first_name": "Thalia", "id": 186 }, "268": { "first_name": "Gia", "id": 268 }, "270": { "first_name": "Alexandria", "id": 270 }, "301": { "first_name": "Emilia", "id": 301 }, "314": { "first_name": "Theresia", "id": 314 }, "425": { "first_name": "Lelia", "id": 425 }, "450": { "first_name": "Shania", "id": 450 }, "467": { "first_name": "Zaria", "id": 467 }, "508": { "first_name": "Thalia", "id": 508 }, "538": { "first_name": "Delia", "id": 538 }, "545": { "first_name": "Alia", "id": 545 }, "621": { "first_name": "Cecilia", "id": 621 }, "625": { "first_name": "Estefania", "id": 625 }, "669": { "first_name": "Adelia", "id": 669 } };
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', true, undefined, 10], undefined, 'all arguments');
        assert.deepEqual(Object.keys(results).length, 17);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse limit 10 offset 10", () => {
        let expected = { "314": { "first_name": "Theresia", "id": 314 }, "425": { "first_name": "Lelia", "id": 425 }, "450": { "first_name": "Shania", "id": 450 }, "467": { "first_name": "Zaria", "id": 467 }, "508": { "first_name": "Thalia", "id": 508 }, "538": { "first_name": "Delia", "id": 538 }, "545": { "first_name": "Alia", "id": 545 }, "621": { "first_name": "Cecilia", "id": 621 }, "625": { "first_name": "Estefania", "id": 625 }, "669": { "first_name": "Adelia", "id": 669 } };
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', true, 10, 10], undefined, 'all arguments');
        assert.deepEqual(Object.keys(results).length, 10);
        assert.deepEqual(results, expected);
    });
});