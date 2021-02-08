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

describe('test startsWith function', ()=> {
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

    it("test search on first_name limit 20", () => {
        let expected = {"17":{"first_name":"Margarita","id":17},"62":{"first_name":"Maria","id":62},"86":{"first_name":"Marisol","id":86},"145":{"first_name":"Mariano","id":145},"265":{"first_name":"Margarita","id":265},"278":{"first_name":"Marcus","id":278},"500":{"first_name":"Marlee","id":500},"555":{"first_name":"Mariela","id":555},"586":{"first_name":"Marcellus","id":586},"650":{"first_name":"Mark","id":650},"739":{"first_name":"Maribel","id":739},"764":{"first_name":"Margaret","id":764},"777":{"first_name":"Marjolaine","id":777},"805":{"first_name":"Margot","id":805},"877":{"first_name":"Mariah","id":877},"880":{"first_name":"Marco","id":880},"882":{"first_name":"Marlin","id":882},"884":{"first_name":"Marc","id":884},"936":{"first_name":"Marcia","id":936},"966":{"first_name":"Mara","id":966}};

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', false, 20], undefined, 'all arguments');
        assert.deepStrictEqual(Object.keys(results).length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name offset 20", () => {
        let expected = { "106": { "first_name": "Marquise", "id": 106 }, "156": { "first_name": "Maryse", "id": 156 }, "563": { "first_name": "Marquis", "id": 563 }, "738": { "first_name": "Marques", "id": 738 }, "770": { "first_name": "Marty", "id": 770 } };

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', false, undefined, 20], undefined, 'all arguments');
        assert.deepStrictEqual(Object.keys(results).length, 5);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name offset 10 limit 20", () => {
        let expected = {"62":{"first_name":"Maria","id":62},"86":{"first_name":"Marisol","id":86},"106":{"first_name":"Marquise","id":106},"145":{"first_name":"Mariano","id":145},"156":{"first_name":"Maryse","id":156},"500":{"first_name":"Marlee","id":500},"555":{"first_name":"Mariela","id":555},"563":{"first_name":"Marquis","id":563},"650":{"first_name":"Mark","id":650},"738":{"first_name":"Marques","id":738},"739":{"first_name":"Maribel","id":739},"770":{"first_name":"Marty","id":770},"777":{"first_name":"Marjolaine","id":777},"877":{"first_name":"Mariah","id":877},"882":{"first_name":"Marlin","id":882}};

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', false, 20, 10], undefined, 'all arguments');
        assert.deepStrictEqual(Object.keys(results).length, 15);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse", () => {
        let expected = { "17": { "first_name": "Margarita", "id": 17 }, "62": { "first_name": "Maria", "id": 62 }, "86": { "first_name": "Marisol", "id": 86 }, "106": { "first_name": "Marquise", "id": 106 }, "145": { "first_name": "Mariano", "id": 145 }, "156": { "first_name": "Maryse", "id": 156 }, "265": { "first_name": "Margarita", "id": 265 }, "278": { "first_name": "Marcus", "id": 278 }, "500": { "first_name": "Marlee", "id": 500 }, "555": { "first_name": "Mariela", "id": 555 }, "563": { "first_name": "Marquis", "id": 563 }, "586": { "first_name": "Marcellus", "id": 586 }, "650": { "first_name": "Mark", "id": 650 }, "738": { "first_name": "Marques", "id": 738 }, "739": { "first_name": "Maribel", "id": 739 }, "764": { "first_name": "Margaret", "id": 764 }, "770": { "first_name": "Marty", "id": 770 }, "777": { "first_name": "Marjolaine", "id": 777 }, "805": { "first_name": "Margot", "id": 805 }, "877": { "first_name": "Mariah", "id": 877 }, "880": { "first_name": "Marco", "id": 880 }, "882": { "first_name": "Marlin", "id": 882 }, "884": { "first_name": "Marc", "id": 884 }, "936": { "first_name": "Marcia", "id": 936 }, "966": { "first_name": "Mara", "id": 966 } };

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', true], undefined, 'all arguments');
        assert.deepStrictEqual(Object.keys(results).length, 25);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse limit 15", () => {
        let expected = {"62":{"first_name":"Maria","id":62},"86":{"first_name":"Marisol","id":86},"106":{"first_name":"Marquise","id":106},"145":{"first_name":"Mariano","id":145},"156":{"first_name":"Maryse","id":156},"500":{"first_name":"Marlee","id":500},"555":{"first_name":"Mariela","id":555},"563":{"first_name":"Marquis","id":563},"650":{"first_name":"Mark","id":650},"738":{"first_name":"Marques","id":738},"739":{"first_name":"Maribel","id":739},"770":{"first_name":"Marty","id":770},"777":{"first_name":"Marjolaine","id":777},"877":{"first_name":"Mariah","id":877},"882":{"first_name":"Marlin","id":882}};

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', true, 15], undefined, 'all arguments');
        assert.deepStrictEqual(Object.keys(results).length, 15);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse offset 20", () => {
        let expected = { "586": { "first_name": "Marcellus", "id": 586 }, "880": { "first_name": "Marco", "id": 880 }, "884": { "first_name": "Marc", "id": 884 }, "936": { "first_name": "Marcia", "id": 936 }, "966": { "first_name": "Mara", "id": 966 } };

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', true, undefined, 20], undefined, 'all arguments');
        assert.deepStrictEqual(Object.keys(results).length, 5);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse offset 10 limit 20", () => {
        let expected = {"17":{"first_name":"Margarita","id":17},"62":{"first_name":"Maria","id":62},"145":{"first_name":"Mariano","id":145},"265":{"first_name":"Margarita","id":265},"278":{"first_name":"Marcus","id":278},"555":{"first_name":"Mariela","id":555},"586":{"first_name":"Marcellus","id":586},"739":{"first_name":"Maribel","id":739},"764":{"first_name":"Margaret","id":764},"805":{"first_name":"Margot","id":805},"877":{"first_name":"Mariah","id":877},"880":{"first_name":"Marco","id":880},"884":{"first_name":"Marc","id":884},"936":{"first_name":"Marcia","id":936},"966":{"first_name":"Mara","id":966}};

        let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', true, 20, 10], undefined, 'all arguments');
        assert.deepStrictEqual(Object.keys(results).length, 15);
        assert.deepEqual(results, expected);
    });
});