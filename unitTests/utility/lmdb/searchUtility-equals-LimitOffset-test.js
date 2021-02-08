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

describe('test equals function', ()=> {
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
        let expected = {"58":{"id":58,"state":"CO"},"60":{"id":60,"state":"CO"},"83":{"id":83,"state":"CO"},"88":{"id":88,"state":"CO"},"172":{"id":172,"state":"CO"},"224":{"id":224,"state":"CO"},"229":{"id":229,"state":"CO"},"330":{"id":330,"state":"CO"},"384":{"id":384,"state":"CO"},"418":{"id":418,"state":"CO"}}

        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'state', 'CO', false, 10], undefined, 'all arguments');
        assert.deepEqual(Object.keys(results).length, 10);
        assert.deepEqual(results, expected);
    });

    it("test search on state offset 10", () => {
        let expected = { "481": { "state": "CO", "id": 481 }, "521": { "state": "CO", "id": 521 }, "611": { "state": "CO", "id": 611 }, "644": { "state": "CO", "id": 644 }, "658": { "state": "CO", "id": 658 }, "701": { "state": "CO", "id": 701 }, "943": { "state": "CO", "id": 943 }, "946": { "state": "CO", "id": 946 }, "967": { "state": "CO", "id": 967 } };

        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'state', 'CO', false, undefined, 10], undefined, 'all arguments');
        assert.deepEqual(Object.keys(results).length, 9);
        assert.deepEqual(results, expected);
    });

    it("test search on state, limit 1000", () => {
        let expected = {"58":{"state":"CO"},"60":{"state":"CO"},"83":{"state":"CO"},"88":{"state":"CO"},"172":{"state":"CO"},"224":{"state":"CO"},"229":{"state":"CO"},"330":{"state":"CO"},"384":{"state":"CO"},"418":{"state":"CO"},"481":{"state":"CO"},"521":{"state":"CO"},"611":{"state":"CO"},"644":{"state":"CO"},"658":{"state":"CO"},"701":{"state":"CO"},"943":{"state":"CO"},"946":{"state":"CO"},"967":{"state":"CO"}};

        let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', false, 1000], undefined, 'all arguments');
        assert.deepEqual(Object.keys(results).length, 19);
        assert.deepEqual(results, expected);
    });

    it("test search on state, offset 10 limit 5", () => {
        let expected = {"481":{"state":"CO"},"521":{"state":"CO"},"611":{"state":"CO"},"644":{"state":"CO"},"658":{"state":"CO"}};

        let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', false, 5, 10], undefined, 'all arguments');
        assert.deepEqual(Object.keys(results).length, 5);
        assert.deepEqual(results, expected);
    });

    it("test search on state, offset 1000 limit 5", () => {
        let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', false, 5, 1000], undefined, 'all arguments');
        assert.deepEqual(results, {});
    });

    it("test search on state reverse", () => {
        let expected = { "58": { "state": "CO", "id": 58 }, "60": { "state": "CO", "id": 60 }, "83": { "state": "CO", "id": 83 }, "88": { "state": "CO", "id": 88 }, "172": { "state": "CO", "id": 172 }, "224": { "state": "CO", "id": 224 }, "229": { "state": "CO", "id": 229 }, "330": { "state": "CO", "id": 330 }, "384": { "state": "CO", "id": 384 }, "418": { "state": "CO", "id": 418 }, "481": { "state": "CO", "id": 481 }, "521": { "state": "CO", "id": 521 }, "611": { "state": "CO", "id": 611 }, "644": { "state": "CO", "id": 644 }, "658": { "state": "CO", "id": 658 }, "701": { "state": "CO", "id": 701 }, "943": { "state": "CO", "id": 943 }, "946": { "state": "CO", "id": 946 }, "967": { "state": "CO", "id": 967 } };

        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'state', 'CO', true], undefined, 'all arguments');
        assert.deepEqual(Object.keys(results).length, 19);
        assert.deepEqual(results, expected);
    });

    it("test search on state reverse limit 10", () => {
        let expected = {"418":{"id":418,"state":"CO"},"481":{"id":481,"state":"CO"},"521":{"id":521,"state":"CO"},"611":{"id":611,"state":"CO"},"644":{"id":644,"state":"CO"},"658":{"id":658,"state":"CO"},"701":{"id":701,"state":"CO"},"943":{"id":943,"state":"CO"},"946":{"id":946,"state":"CO"},"967":{"id":967,"state":"CO"}};

        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'state', 'CO', true, 10], undefined, 'all arguments');
        assert.deepEqual(Object.keys(results).length, 10);
        assert.deepEqual(results, expected);
    });

    it("test search on state reverse offset 10", () => {
        let expected = { "58": { "state": "CO", "id": 58 }, "60": { "state": "CO", "id": 60 }, "83": { "state": "CO", "id": 83 }, "88": { "state": "CO", "id": 88 }, "172": { "state": "CO", "id": 172 }, "224": { "state": "CO", "id": 224 }, "229": { "state": "CO", "id": 229 }, "330": { "state": "CO", "id": 330 }, "384": { "state": "CO", "id": 384 } };

        let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'state', 'CO', true, undefined, 10], undefined, 'all arguments');
        assert.deepEqual(Object.keys(results).length, 9);
        assert.deepEqual(results, expected);
    });

    it("test search on state, reverse, limit 1000", () => {
        let expected = {"58":{"state":"CO"},"60":{"state":"CO"},"83":{"state":"CO"},"88":{"state":"CO"},"172":{"state":"CO"},"224":{"state":"CO"},"229":{"state":"CO"},"330":{"state":"CO"},"384":{"state":"CO"},"418":{"state":"CO"},"481":{"state":"CO"},"521":{"state":"CO"},"611":{"state":"CO"},"644":{"state":"CO"},"658":{"state":"CO"},"701":{"state":"CO"},"943":{"state":"CO"},"946":{"state":"CO"},"967":{"state":"CO"}};

        let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', true, 1000], undefined, 'all arguments');
        assert.deepEqual(Object.keys(results).length, 19);
        assert.deepEqual(results, expected);
    });

    it("test search on state, reverse offset 10 limit 5", () => {
        let expected = {"172":{"state":"CO"},"224":{"state":"CO"},"229":{"state":"CO"},"330":{"state":"CO"},"384":{"state":"CO"}};

        let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', true, 5, 10], undefined, 'all arguments');
        assert.deepEqual(Object.keys(results).length, 5);
        assert.deepEqual(results, expected);
    });

    it("test search on state, reverse offset 1000 limit 5", () => {
        let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', true, 5, 1000], undefined, 'all arguments');
        assert.deepEqual(results, {});
    });
});