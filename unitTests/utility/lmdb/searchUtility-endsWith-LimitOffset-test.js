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
const TIMESTAMP = Date.now();

const MULTI_RECORD_ARRAY2 = [
    {id:1, name:'Kyle', age:46, city:'Denver'},
    {id:2, name:'Jerry', age:32},
    {id:3, name: 'Hank', age: 57},
    {id:4, name:'Joy', age: 44, city:'Denver'},
    {id:5, name:'Fran', age: 44, city:'Denvertown'},
    {id:6, city:'Nowhere'},
];


describe('test endsWith function', ()=> {
    let env;
    before(async () => {
        global.lmdb_map = undefined;
        await fs.remove(test_utils.getMockFSPath());
        await fs.mkdirp(BASE_TEST_PATH);

        env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        await environment_utility.createDBI(env, 'id', false, true);
        await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(All_ATTRIBUTES), MULTI_RECORD_ARRAY2);
    });

    after(async () => {
        env.close();
        global.lmdb_map = undefined;
        await fs.remove(test_utils.getMockFSPath());
    });

    it("test validation", () => {
        test_utils.assertErrorSync(search_util.endsWith, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
        test_utils.assertErrorSync(search_util.endsWith, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
        test_utils.assertErrorSync(search_util.endsWith, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no hash attribute');
        test_utils.assertErrorSync(search_util.endsWith, [env,'id', 'city'], LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED, 'no search_value');
        test_utils.assertErrorSync(search_util.endsWith, [env,'id', 'city', 'Denver'], undefined, 'all arguments');
    });

    it("test search on city", () => {
        let expected = [[1,4],[{"city": "Denver","id": 1},{"city": "Denver","id": 4}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'city', 'ver'], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 2);
        assert.deepEqual(results[1].length, 2);
        assert.deepEqual(results, expected);
    });

    it("test search on city, no hash", () => {
        let expected = [[1,4],[{"city": "Denver"},{"city": "Denver"}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, undefined, 'city', 'ver'], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 2);
        assert.deepEqual(results[1].length, 2);
        assert.deepEqual(results, expected);
    });

    it("test search on city with Denver", () => {
        let expected = [[1,4],[{"city": "Denver","id": 1},{"city": "Denver","id": 4}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id','city', 'Denver'], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 2);
        assert.deepEqual(results[1].length, 2);
        assert.deepEqual(results, expected);
    });

    it("test search on city with town", () => {
        let expected = [[5],[{"city": "Denvertown","id": 5}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'city', 'town'], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 1);
        assert.deepEqual(results[1].length, 1);
        assert.deepEqual(results, expected);
    });

    it("test search on city with non-existent value", () => {
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'city', 'FoCo'], undefined, 'all arguments');
        assert.deepStrictEqual(results, [[],[]]);
    });

    it("test search on attribute no exist", () => {
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id','fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
        assert.deepStrictEqual(results, undefined);
    });

    it("test search on hash attribute", () => {
        let expected = [[1],[{"id": 1}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'id', '1'], undefined);
        assert.deepEqual(results[0].length, 1);
        assert.deepEqual(results[1].length, 1);
        assert.deepEqual(results, expected);
    });
});

describe('test endsWith function reverse limit offset', ()=> {
    let env;
    let date_stub;
    before(async () => {
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
        global.lmdb_map = undefined;
        await fs.remove(test_utils.getMockFSPath());
        await fs.mkdirp(BASE_TEST_PATH);

        env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        await environment_utility.createDBI(env, 'id', false, true);
        await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(PERSON_ATTRIBUTES), test_utils.deepClone(test_data));
    });

    after(async () => {
        date_stub.restore();
        env.close();
        global.lmdb_map = undefined;
        await fs.remove(test_utils.getMockFSPath());
    });

    it("test search on id limit 20", () => {
        let expected = [[1,11,21,31,41,51,61,71,81,91,101,111,121,131,141,151,161,171,181,191],[{"id": 1},{"id": 11},{"id": 21},{"id": 31},{"id": 41},{"id": 51},{"id": 61},{"id": 71},{"id": 81},{"id": 91},{"id": 101},{"id": 111},{"id": 121},{"id": 131},{"id": 141},{"id": 151},{"id": 161},{"id": 171},{"id": 181},{"id": 191}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'id', 1, false, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 20);
        assert.deepEqual(results[1].length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on id offset 20", () => {
        let expected = [[201,211,221,231,241,251,261,271,281,291,301,311,321,331,341,351,361,371,381,391,401,411,421,431,441,451,461,471,481,491,501,511,521,531,541,551,561,571,581,591,601,611,621,631,641,651,661,671,681,691,701,711,721,731,741,751,761,771,781,791,801,811,821,831,841,851,861,871,881,891,901,911,921,931,941,951,961,971,981,991],[{"id": 201},{"id": 211},{"id": 221},{"id": 231},{"id": 241},{"id": 251},{"id": 261},{"id": 271},{"id": 281},{"id": 291},{"id": 301},{"id": 311},{"id": 321},{"id": 331},{"id": 341},{"id": 351},{"id": 361},{"id": 371},{"id": 381},{"id": 391},{"id": 401},{"id": 411},{"id": 421},{"id": 431},{"id": 441},{"id": 451},{"id": 461},{"id": 471},{"id": 481},{"id": 491},{"id": 501},{"id": 511},{"id": 521},{"id": 531},{"id": 541},{"id": 551},{"id": 561},{"id": 571},{"id": 581},{"id": 591},{"id": 601},{"id": 611},{"id": 621},{"id": 631},{"id": 641},{"id": 651},{"id": 661},{"id": 671},{"id": 681},{"id": 691},{"id": 701},{"id": 711},{"id": 721},{"id": 731},{"id": 741},{"id": 751},{"id": 761},{"id": 771},{"id": 781},{"id": 791},{"id": 801},{"id": 811},{"id": 821},{"id": 831},{"id": 841},{"id": 851},{"id": 861},{"id": 871},{"id": 881},{"id": 891},{"id": 901},{"id": 911},{"id": 921},{"id": 931},{"id": 941},{"id": 951},{"id": 961},{"id": 971},{"id": 981},{"id": 991}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'id', 1, false, undefined, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 80);
        assert.deepEqual(results[1].length, 80);
        assert.deepEqual(results, expected);
    });

    it("test search on id limit 20 offset 20", () => {
        let expected = [[201,211,221,231,241,251,261,271,281,291,301,311,321,331,341,351,361,371,381,391],[{"id": 201},{"id": 211},{"id": 221},{"id": 231},{"id": 241},{"id": 251},{"id": 261},{"id": 271},{"id": 281},{"id": 291},{"id": 301},{"id": 311},{"id": 321},{"id": 331},{"id": 341},{"id": 351},{"id": 361},{"id": 371},{"id": 381},{"id": 391}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'id', 1, false, 20, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 20);
        assert.deepEqual(results[1].length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on id reverse", () => {
        let expected = [[991,981,971,961,951,941,931,921,911,901,891,881,871,861,851,841,831,821,811,801,791,781,771,761,751,741,731,721,711,701,691,681,671,661,651,641,631,621,611,601,591,581,571,561,551,541,531,521,511,501,491,481,471,461,451,441,431,421,411,401,391,381,371,361,351,341,331,321,311,301,291,281,271,261,251,241,231,221,211,201,191,181,171,161,151,141,131,121,111,101,91,81,71,61,51,41,31,21,11,1],[{"id": 991},{"id": 981},{"id": 971},{"id": 961},{"id": 951},{"id": 941},{"id": 931},{"id": 921},{"id": 911},{"id": 901},{"id": 891},{"id": 881},{"id": 871},{"id": 861},{"id": 851},{"id": 841},{"id": 831},{"id": 821},{"id": 811},{"id": 801},{"id": 791},{"id": 781},{"id": 771},{"id": 761},{"id": 751},{"id": 741},{"id": 731},{"id": 721},{"id": 711},{"id": 701},{"id": 691},{"id": 681},{"id": 671},{"id": 661},{"id": 651},{"id": 641},{"id": 631},{"id": 621},{"id": 611},{"id": 601},{"id": 591},{"id": 581},{"id": 571},{"id": 561},{"id": 551},{"id": 541},{"id": 531},{"id": 521},{"id": 511},{"id": 501},{"id": 491},{"id": 481},{"id": 471},{"id": 461},{"id": 451},{"id": 441},{"id": 431},{"id": 421},{"id": 411},{"id": 401},{"id": 391},{"id": 381},{"id": 371},{"id": 361},{"id": 351},{"id": 341},{"id": 331},{"id": 321},{"id": 311},{"id": 301},{"id": 291},{"id": 281},{"id": 271},{"id": 261},{"id": 251},{"id": 241},{"id": 231},{"id": 221},{"id": 211},{"id": 201},{"id": 191},{"id": 181},{"id": 171},{"id": 161},{"id": 151},{"id": 141},{"id": 131},{"id": 121},{"id": 111},{"id": 101},{"id": 91},{"id": 81},{"id": 71},{"id": 61},{"id": 51},{"id": 41},{"id": 31},{"id": 21},{"id": 11},{"id": 1}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'id', 1, true], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 100);
        assert.deepEqual(results[1].length, 100);
        assert.deepEqual(results, expected);
    });

    it("test search on id reverse limit 20", () => {
        let expected = [[991,981,971,961,951,941,931,921,911,901,891,881,871,861,851,841,831,821,811,801],[{"id": 991},{"id": 981},{"id": 971},{"id": 961},{"id": 951},{"id": 941},{"id": 931},{"id": 921},{"id": 911},{"id": 901},{"id": 891},{"id": 881},{"id": 871},{"id": 861},{"id": 851},{"id": 841},{"id": 831},{"id": 821},{"id": 811},{"id": 801}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'id', 1, true, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 20);
        assert.deepEqual(results[1].length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on id reverse offset 20", () => {
        let expected = [[791,781,771,761,751,741,731,721,711,701,691,681,671,661,651,641,631,621,611,601,591,581,571,561,551,541,531,521,511,501,491,481,471,461,451,441,431,421,411,401,391,381,371,361,351,341,331,321,311,301,291,281,271,261,251,241,231,221,211,201,191,181,171,161,151,141,131,121,111,101,91,81,71,61,51,41,31,21,11,1],[{"id": 791},{"id": 781},{"id": 771},{"id": 761},{"id": 751},{"id": 741},{"id": 731},{"id": 721},{"id": 711},{"id": 701},{"id": 691},{"id": 681},{"id": 671},{"id": 661},{"id": 651},{"id": 641},{"id": 631},{"id": 621},{"id": 611},{"id": 601},{"id": 591},{"id": 581},{"id": 571},{"id": 561},{"id": 551},{"id": 541},{"id": 531},{"id": 521},{"id": 511},{"id": 501},{"id": 491},{"id": 481},{"id": 471},{"id": 461},{"id": 451},{"id": 441},{"id": 431},{"id": 421},{"id": 411},{"id": 401},{"id": 391},{"id": 381},{"id": 371},{"id": 361},{"id": 351},{"id": 341},{"id": 331},{"id": 321},{"id": 311},{"id": 301},{"id": 291},{"id": 281},{"id": 271},{"id": 261},{"id": 251},{"id": 241},{"id": 231},{"id": 221},{"id": 211},{"id": 201},{"id": 191},{"id": 181},{"id": 171},{"id": 161},{"id": 151},{"id": 141},{"id": 131},{"id": 121},{"id": 111},{"id": 101},{"id": 91},{"id": 81},{"id": 71},{"id": 61},{"id": 51},{"id": 41},{"id": 31},{"id": 21},{"id": 11},{"id": 1}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'id', 1, true, undefined, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 80);
        assert.deepEqual(results[1].length, 80);
        assert.deepEqual(results, expected);
    });

    it("test search on id reverse limit 20 offset 20", () => {
        let expected = [[791,781,771,761,751,741,731,721,711,701,691,681,671,661,651,641,631,621,611,601],[{"id": 791},{"id": 781},{"id": 771},{"id": 761},{"id": 751},{"id": 741},{"id": 731},{"id": 721},{"id": 711},{"id": 701},{"id": 691},{"id": 681},{"id": 671},{"id": 661},{"id": 651},{"id": 641},{"id": 631},{"id": 621},{"id": 611},{"id": 601}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'id', 1, true, 20, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 20);
        assert.deepEqual(results[1].length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name limit 10", () => {
        let expected = [[669,270,545,898,876,621,795,538,19,301],[{"first_name": "Adelia","id": 669},{"first_name": "Alexandria","id": 270},{"first_name": "Alia","id": 545},{"first_name": "Asia","id": 898},{"first_name": "Bria","id": 876},{"first_name": "Cecilia","id": 621},{"first_name": "Dahlia","id": 795},{"first_name": "Delia","id": 538},{"first_name": "Delphia","id": 19},{"first_name": "Emilia","id": 301}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', false, 10], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 10);
        assert.deepEqual(results[1].length, 10);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name limit 10 offset 10", () => {
        let expected = [[625,968,268,685,425,871,936,62,692,450],[{"first_name": "Estefania","id": 625},{"first_name": "Eugenia","id": 968},{"first_name": "Gia","id": 268},{"first_name": "Gregoria","id": 685},{"first_name": "Lelia","id": 425},{"first_name": "Magnolia","id": 871},{"first_name": "Marcia","id": 936},{"first_name": "Maria","id": 62},{"first_name": "Otilia","id": 692},{"first_name": "Shania","id": 450}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', false, 10, 10], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 10);
        assert.deepEqual(results[1].length, 10);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse", () => {
        let expected = [[467,901,314,186,508,922,151,450,692,62,936,871,425,685,268,968,625,301,19,538,795,621,876,898,545,270,669],[{"first_name": "Zaria","id": 467},{"first_name": "Trycia","id": 901},{"first_name": "Theresia","id": 314},{"first_name": "Thalia","id": 186},{"first_name": "Thalia","id": 508},{"first_name": "Thalia","id": 922},{"first_name": "Sofia","id": 151},{"first_name": "Shania","id": 450},{"first_name": "Otilia","id": 692},{"first_name": "Maria","id": 62},{"first_name": "Marcia","id": 936},{"first_name": "Magnolia","id": 871},{"first_name": "Lelia","id": 425},{"first_name": "Gregoria","id": 685},{"first_name": "Gia","id": 268},{"first_name": "Eugenia","id": 968},{"first_name": "Estefania","id": 625},{"first_name": "Emilia","id": 301},{"first_name": "Delphia","id": 19},{"first_name": "Delia","id": 538},{"first_name": "Dahlia","id": 795},{"first_name": "Cecilia","id": 621},{"first_name": "Bria","id": 876},{"first_name": "Asia","id": 898},{"first_name": "Alia","id": 545},{"first_name": "Alexandria","id": 270},{"first_name": "Adelia","id": 669}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', true], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 27);
        assert.deepEqual(results[1].length, 27);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse limit 10", () => {
        let expected = [[467,901,314,186,508,922,151,450,692,62],[{"first_name": "Zaria","id": 467},{"first_name": "Trycia","id": 901},{"first_name": "Theresia","id": 314},{"first_name": "Thalia","id": 186},{"first_name": "Thalia","id": 508},{"first_name": "Thalia","id": 922},{"first_name": "Sofia","id": 151},{"first_name": "Shania","id": 450},{"first_name": "Otilia","id": 692},{"first_name": "Maria","id": 62}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', true, 10], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 10);
        assert.deepEqual(results[1].length, 10);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse offset 10", () => {
        let expected = [[936,871,425,685,268,968,625,301,19,538,795,621,876,898,545,270,669],[{"first_name": "Marcia","id": 936},{"first_name": "Magnolia","id": 871},{"first_name": "Lelia","id": 425},{"first_name": "Gregoria","id": 685},{"first_name": "Gia","id": 268},{"first_name": "Eugenia","id": 968},{"first_name": "Estefania","id": 625},{"first_name": "Emilia","id": 301},{"first_name": "Delphia","id": 19},{"first_name": "Delia","id": 538},{"first_name": "Dahlia","id": 795},{"first_name": "Cecilia","id": 621},{"first_name": "Bria","id": 876},{"first_name": "Asia","id": 898},{"first_name": "Alia","id": 545},{"first_name": "Alexandria","id": 270},{"first_name": "Adelia","id": 669}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', true, undefined, 10], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 17);
        assert.deepEqual(results[1].length, 17);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse limit 10 offset 10", () => {
        let expected = [[936,871,425,685,268,968,625,301,19,538],[{"first_name": "Marcia","id": 936},{"first_name": "Magnolia","id": 871},{"first_name": "Lelia","id": 425},{"first_name": "Gregoria","id": 685},{"first_name": "Gia","id": 268},{"first_name": "Eugenia","id": 968},{"first_name": "Estefania","id": 625},{"first_name": "Emilia","id": 301},{"first_name": "Delphia","id": 19},{"first_name": "Delia","id": 538}]];
        let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', true, 10, 10], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 10);
        assert.deepEqual(results[1].length, 10);
        assert.deepEqual(results, expected);
    });
});