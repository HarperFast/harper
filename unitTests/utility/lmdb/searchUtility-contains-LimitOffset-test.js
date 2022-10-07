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
const uuid = require('uuid').v4;
const sandbox = sinon.createSandbox();
const BASE_TEST_PATH = path.join(test_utils.getMockLMDBPath(), 'lmdbTest');
let TEST_ENVIRONMENT_NAME = 'test';
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

describe('test contains function', ()=> {

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
        test_utils.assertErrorSync(search_util.contains, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
        test_utils.assertErrorSync(search_util.contains, [HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid env variable');
        test_utils.assertErrorSync(search_util.contains, [env], LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED, 'no hash attribute');
        test_utils.assertErrorSync(search_util.contains, [env,'id', 'city'], LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED, 'no search_value');
        test_utils.assertErrorSync(search_util.contains, [env,'id', 'city', 'Denver'], undefined, 'all arguments');
    });

    it("test search on city", () => {
        let expected = [[1,4,5],[{"city": "Denver","id": 1},{"city": "Denver","id": 4},{"city": "Denvertown","id": 5}]];
        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'city', 'ver'], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 3);
        assert.deepEqual(results[1].length, 3);
        assert.deepEqual(results, expected);
    });

    it("test search on city with Denver", () => {
        let expected = [[1,4,5],[{"city": "Denver","id": 1},{"city": "Denver","id": 4},{"city": "Denvertown","id": 5}]];
        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'city', 'Denver'], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 3);
        assert.deepEqual(results[1].length, 3);
        assert.deepEqual(results, expected);
    });

    it("test search on city with town", () => {
        let expected = [[5],[{"city": "Denvertown","id": 5}]];
        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'city', 'town'], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 1);
        assert.deepEqual(results[1].length, 1);
        assert.deepEqual(results, expected);
    });

    it("test search on city with non-existent value", () => {
        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'city', 'FoCo'], undefined, 'all arguments');
        assert.deepStrictEqual(results, [[],[]]);
    });

    it("test search on attribute no exist", () => {
        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id','fake', 'bad'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
        assert.deepStrictEqual(results, undefined);
    });

    it("test search on id with 3", () => {
        let expected = [[3],[{"id": 3}]];
        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'id', 3], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 1);
        assert.deepEqual(results[1].length, 1);
        assert.deepEqual(results, expected);
    });
});

describe('test contains function reverse limit offset', ()=> {
    let env;
    let date_stub;
    before(async () => {
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
        global.lmdb_map = undefined;
        await fs.remove(test_utils.getMockLMDBPath());
        await fs.mkdirp(BASE_TEST_PATH);
        TEST_ENVIRONMENT_NAME = uuid();
        env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        await environment_utility.createDBI(env, 'id', false, true);
        await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(PERSON_ATTRIBUTES), test_utils.deepClone(test_data));
    });

    after(async () => {
        date_stub.restore();
        await env.close();
        global.lmdb_map = undefined;
        await fs.remove(test_utils.getMockLMDBPath());
    });

    it("test search on id limit 20", () => {
        let expected = [[0,10,20,30,40,50,60,70,80,90,100,101,102,103,104,105,106,107,108,109],[{"id": 0},{"id": 10},{"id": 20},{"id": 30},{"id": 40},{"id": 50},{"id": 60},{"id": 70},{"id": 80},{"id": 90},{"id": 100},{"id": 101},{"id": 102},{"id": 103},{"id": 104},{"id": 105},{"id": 106},{"id": 107},{"id": 108},{"id": 109}]];

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'id', '0', false, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 20);
        assert.deepEqual(results[1].length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on id offset 20", () => {
        let expected = [[110,120,130,140,150,160,170,180,190,200,201,202,203,204,205,206,207,208,209,210,220,230,240,250,260,270,280,290,300,301,302,303,304,305,306,307,308,309,310,320,330,340,350,360,370,380,390,400,401,402,403,404,405,406,407,408,409,410,420,430,440,450,460,470,480,490,500,501,502,503,504,505,506,507,508,509,510,520,530,540,550,560,570,580,590,600,601,602,603,604,605,606,607,608,609,610,620,630,640,650,660,670,680,690,700,701,702,703,704,705,706,707,708,709,710,720,730,740,750,760,770,780,790,800,801,802,803,804,805,806,807,808,809,810,820,830,840,850,860,870,880,890,900,901,902,903,904,905,906,907,908,909,910,920,930,940,950,960,970,980,990],[{"id": 110},{"id": 120},{"id": 130},{"id": 140},{"id": 150},{"id": 160},{"id": 170},{"id": 180},{"id": 190},{"id": 200},{"id": 201},{"id": 202},{"id": 203},{"id": 204},{"id": 205},{"id": 206},{"id": 207},{"id": 208},{"id": 209},{"id": 210},{"id": 220},{"id": 230},{"id": 240},{"id": 250},{"id": 260},{"id": 270},{"id": 280},{"id": 290},{"id": 300},{"id": 301},{"id": 302},{"id": 303},{"id": 304},{"id": 305},{"id": 306},{"id": 307},{"id": 308},{"id": 309},{"id": 310},{"id": 320},{"id": 330},{"id": 340},{"id": 350},{"id": 360},{"id": 370},{"id": 380},{"id": 390},{"id": 400},{"id": 401},{"id": 402},{"id": 403},{"id": 404},{"id": 405},{"id": 406},{"id": 407},{"id": 408},{"id": 409},{"id": 410},{"id": 420},{"id": 430},{"id": 440},{"id": 450},{"id": 460},{"id": 470},{"id": 480},{"id": 490},{"id": 500},{"id": 501},{"id": 502},{"id": 503},{"id": 504},{"id": 505},{"id": 506},{"id": 507},{"id": 508},{"id": 509},{"id": 510},{"id": 520},{"id": 530},{"id": 540},{"id": 550},{"id": 560},{"id": 570},{"id": 580},{"id": 590},{"id": 600},{"id": 601},{"id": 602},{"id": 603},{"id": 604},{"id": 605},{"id": 606},{"id": 607},{"id": 608},{"id": 609},{"id": 610},{"id": 620},{"id": 630},{"id": 640},{"id": 650},{"id": 660},{"id": 670},{"id": 680},{"id": 690},{"id": 700},{"id": 701},{"id": 702},{"id": 703},{"id": 704},{"id": 705},{"id": 706},{"id": 707},{"id": 708},{"id": 709},{"id": 710},{"id": 720},{"id": 730},{"id": 740},{"id": 750},{"id": 760},{"id": 770},{"id": 780},{"id": 790},{"id": 800},{"id": 801},{"id": 802},{"id": 803},{"id": 804},{"id": 805},{"id": 806},{"id": 807},{"id": 808},{"id": 809},{"id": 810},{"id": 820},{"id": 830},{"id": 840},{"id": 850},{"id": 860},{"id": 870},{"id": 880},{"id": 890},{"id": 900},{"id": 901},{"id": 902},{"id": 903},{"id": 904},{"id": 905},{"id": 906},{"id": 907},{"id": 908},{"id": 909},{"id": 910},{"id": 920},{"id": 930},{"id": 940},{"id": 950},{"id": 960},{"id": 970},{"id": 980},{"id": 990}]];

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'id', '0', false, undefined, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 161);
        assert.deepEqual(results[1].length, 161);
        assert.deepEqual(results, expected);
    });

    it("test search on id limit 20 offset 20", () => {
        let expected = [[110,120,130,140,150,160,170,180,190,200,201,202,203,204,205,206,207,208,209,210],[{"id": 110},{"id": 120},{"id": 130},{"id": 140},{"id": 150},{"id": 160},{"id": 170},{"id": 180},{"id": 190},{"id": 200},{"id": 201},{"id": 202},{"id": 203},{"id": 204},{"id": 205},{"id": 206},{"id": 207},{"id": 208},{"id": 209},{"id": 210}]];

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'id', '0', false, 20, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 20);
        assert.deepEqual(results[1].length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on id reverse", () => {
        let expected = [[990,980,970,960,950,940,930,920,910,909,908,907,906,905,904,903,902,901,900,890,880,870,860,850,840,830,820,810,809,808,807,806,805,804,803,802,801,800,790,780,770,760,750,740,730,720,710,709,708,707,706,705,704,703,702,701,700,690,680,670,660,650,640,630,620,610,609,608,607,606,605,604,603,602,601,600,590,580,570,560,550,540,530,520,510,509,508,507,506,505,504,503,502,501,500,490,480,470,460,450,440,430,420,410,409,408,407,406,405,404,403,402,401,400,390,380,370,360,350,340,330,320,310,309,308,307,306,305,304,303,302,301,300,290,280,270,260,250,240,230,220,210,209,208,207,206,205,204,203,202,201,200,190,180,170,160,150,140,130,120,110,109,108,107,106,105,104,103,102,101,100,90,80,70,60,50,40,30,20,10,0],[{"id": 990},{"id": 980},{"id": 970},{"id": 960},{"id": 950},{"id": 940},{"id": 930},{"id": 920},{"id": 910},{"id": 909},{"id": 908},{"id": 907},{"id": 906},{"id": 905},{"id": 904},{"id": 903},{"id": 902},{"id": 901},{"id": 900},{"id": 890},{"id": 880},{"id": 870},{"id": 860},{"id": 850},{"id": 840},{"id": 830},{"id": 820},{"id": 810},{"id": 809},{"id": 808},{"id": 807},{"id": 806},{"id": 805},{"id": 804},{"id": 803},{"id": 802},{"id": 801},{"id": 800},{"id": 790},{"id": 780},{"id": 770},{"id": 760},{"id": 750},{"id": 740},{"id": 730},{"id": 720},{"id": 710},{"id": 709},{"id": 708},{"id": 707},{"id": 706},{"id": 705},{"id": 704},{"id": 703},{"id": 702},{"id": 701},{"id": 700},{"id": 690},{"id": 680},{"id": 670},{"id": 660},{"id": 650},{"id": 640},{"id": 630},{"id": 620},{"id": 610},{"id": 609},{"id": 608},{"id": 607},{"id": 606},{"id": 605},{"id": 604},{"id": 603},{"id": 602},{"id": 601},{"id": 600},{"id": 590},{"id": 580},{"id": 570},{"id": 560},{"id": 550},{"id": 540},{"id": 530},{"id": 520},{"id": 510},{"id": 509},{"id": 508},{"id": 507},{"id": 506},{"id": 505},{"id": 504},{"id": 503},{"id": 502},{"id": 501},{"id": 500},{"id": 490},{"id": 480},{"id": 470},{"id": 460},{"id": 450},{"id": 440},{"id": 430},{"id": 420},{"id": 410},{"id": 409},{"id": 408},{"id": 407},{"id": 406},{"id": 405},{"id": 404},{"id": 403},{"id": 402},{"id": 401},{"id": 400},{"id": 390},{"id": 380},{"id": 370},{"id": 360},{"id": 350},{"id": 340},{"id": 330},{"id": 320},{"id": 310},{"id": 309},{"id": 308},{"id": 307},{"id": 306},{"id": 305},{"id": 304},{"id": 303},{"id": 302},{"id": 301},{"id": 300},{"id": 290},{"id": 280},{"id": 270},{"id": 260},{"id": 250},{"id": 240},{"id": 230},{"id": 220},{"id": 210},{"id": 209},{"id": 208},{"id": 207},{"id": 206},{"id": 205},{"id": 204},{"id": 203},{"id": 202},{"id": 201},{"id": 200},{"id": 190},{"id": 180},{"id": 170},{"id": 160},{"id": 150},{"id": 140},{"id": 130},{"id": 120},{"id": 110},{"id": 109},{"id": 108},{"id": 107},{"id": 106},{"id": 105},{"id": 104},{"id": 103},{"id": 102},{"id": 101},{"id": 100},{"id": 90},{"id": 80},{"id": 70},{"id": 60},{"id": 50},{"id": 40},{"id": 30},{"id": 20},{"id": 10},{"id": 0}]];

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'id', '0', true], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 181);
        assert.deepEqual(results[1].length, 181);
        assert.deepEqual(results, expected);
    });

    it("test search on id reverse limit 20", () => {
        let expected = [[990,980,970,960,950,940,930,920,910,909,908,907,906,905,904,903,902,901,900,890],[{"id": 990},{"id": 980},{"id": 970},{"id": 960},{"id": 950},{"id": 940},{"id": 930},{"id": 920},{"id": 910},{"id": 909},{"id": 908},{"id": 907},{"id": 906},{"id": 905},{"id": 904},{"id": 903},{"id": 902},{"id": 901},{"id": 900},{"id": 890}]];

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'id', '0', true, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 20);
        assert.deepEqual(results[1].length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on id reverse offset 20", () => {
        let expected = [[880,870,860,850,840,830,820,810,809,808,807,806,805,804,803,802,801,800,790,780,770,760,750,740,730,720,710,709,708,707,706,705,704,703,702,701,700,690,680,670,660,650,640,630,620,610,609,608,607,606,605,604,603,602,601,600,590,580,570,560,550,540,530,520,510,509,508,507,506,505,504,503,502,501,500,490,480,470,460,450,440,430,420,410,409,408,407,406,405,404,403,402,401,400,390,380,370,360,350,340,330,320,310,309,308,307,306,305,304,303,302,301,300,290,280,270,260,250,240,230,220,210,209,208,207,206,205,204,203,202,201,200,190,180,170,160,150,140,130,120,110,109,108,107,106,105,104,103,102,101,100,90,80,70,60,50,40,30,20,10,0],[{"id": 880},{"id": 870},{"id": 860},{"id": 850},{"id": 840},{"id": 830},{"id": 820},{"id": 810},{"id": 809},{"id": 808},{"id": 807},{"id": 806},{"id": 805},{"id": 804},{"id": 803},{"id": 802},{"id": 801},{"id": 800},{"id": 790},{"id": 780},{"id": 770},{"id": 760},{"id": 750},{"id": 740},{"id": 730},{"id": 720},{"id": 710},{"id": 709},{"id": 708},{"id": 707},{"id": 706},{"id": 705},{"id": 704},{"id": 703},{"id": 702},{"id": 701},{"id": 700},{"id": 690},{"id": 680},{"id": 670},{"id": 660},{"id": 650},{"id": 640},{"id": 630},{"id": 620},{"id": 610},{"id": 609},{"id": 608},{"id": 607},{"id": 606},{"id": 605},{"id": 604},{"id": 603},{"id": 602},{"id": 601},{"id": 600},{"id": 590},{"id": 580},{"id": 570},{"id": 560},{"id": 550},{"id": 540},{"id": 530},{"id": 520},{"id": 510},{"id": 509},{"id": 508},{"id": 507},{"id": 506},{"id": 505},{"id": 504},{"id": 503},{"id": 502},{"id": 501},{"id": 500},{"id": 490},{"id": 480},{"id": 470},{"id": 460},{"id": 450},{"id": 440},{"id": 430},{"id": 420},{"id": 410},{"id": 409},{"id": 408},{"id": 407},{"id": 406},{"id": 405},{"id": 404},{"id": 403},{"id": 402},{"id": 401},{"id": 400},{"id": 390},{"id": 380},{"id": 370},{"id": 360},{"id": 350},{"id": 340},{"id": 330},{"id": 320},{"id": 310},{"id": 309},{"id": 308},{"id": 307},{"id": 306},{"id": 305},{"id": 304},{"id": 303},{"id": 302},{"id": 301},{"id": 300},{"id": 290},{"id": 280},{"id": 270},{"id": 260},{"id": 250},{"id": 240},{"id": 230},{"id": 220},{"id": 210},{"id": 209},{"id": 208},{"id": 207},{"id": 206},{"id": 205},{"id": 204},{"id": 203},{"id": 202},{"id": 201},{"id": 200},{"id": 190},{"id": 180},{"id": 170},{"id": 160},{"id": 150},{"id": 140},{"id": 130},{"id": 120},{"id": 110},{"id": 109},{"id": 108},{"id": 107},{"id": 106},{"id": 105},{"id": 104},{"id": 103},{"id": 102},{"id": 101},{"id": 100},{"id": 90},{"id": 80},{"id": 70},{"id": 60},{"id": 50},{"id": 40},{"id": 30},{"id": 20},{"id": 10},{"id": 0}]];

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'id', '0', true, undefined, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 161);
        assert.deepEqual(results[1].length, 161);
        assert.deepEqual(results, expected);
    });

    it("test search on id reverse limit 20 offset 20", () => {
        let expected = [[880,870,860,850,840,830,820,810,809,808,807,806,805,804,803,802,801,800,790,780],[{"id": 880},{"id": 870},{"id": 860},{"id": 850},{"id": 840},{"id": 830},{"id": 820},{"id": 810},{"id": 809},{"id": 808},{"id": 807},{"id": 806},{"id": 805},{"id": 804},{"id": 803},{"id": 802},{"id": 801},{"id": 800},{"id": 790},{"id": 780}]];

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'id', '0', true, 20, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 20);
        assert.deepEqual(results[1].length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name limit 20", () => {
        let expected = [[518,662,523,858,75,679,740,127,646,790,161,612,707,935,465,14,306,979,175,230],[{"first_name": "Abner","id": 518},{"first_name": "Adelbert","id": 662},{"first_name": "Albert","id": 523},{"first_name": "Alvera","id": 858},{"first_name": "Alverta","id": 75},{"first_name": "Anderson","id": 679},{"first_name": "Avery","id": 740},{"first_name": "Bernardo","id": 127},{"first_name": "Bernice","id": 646},{"first_name": "Bernice","id": 790},{"first_name": "Berta","id": 161},{"first_name": "Beryl","id": 612},{"first_name": "Buster","id": 707},{"first_name": "Casper","id": 935},{"first_name": "Cicero","id": 465},{"first_name": "Cierra","id": 14},{"first_name": "Cierra","id": 306},{"first_name": "Delbert","id": 979},{"first_name": "Deron","id": 175},{"first_name": "Derrick","id": 230}]];

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'first_name', 'er', false, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 20);
        assert.deepEqual(results[1].length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name offset 20", () => {
        let expected = [[349,108,475,908,809,21,223,199,92,376,451,191,741,166,382,51,328,655,561,939,924,204,252,584,491,10,726,46,49,424,0,556,712,83,965,697,371,285,28,453,136,686,146,546,961,560,74,218,581,745,417,282,174,653,67,851,423,830,868,779,864,95,461,314,938,291,516,848,570,470,18,645,393,398],[{"first_name": "Everardo","id": 349},{"first_name": "Everette","id": 108},{"first_name": "Everette","id": 475},{"first_name": "Everette","id": 908},{"first_name": "Ferne","id": 809},{"first_name": "Frederik","id": 21},{"first_name": "Frederik","id": 223},{"first_name": "Gerard","id": 199},{"first_name": "Gerhard","id": 92},{"first_name": "Gerhard","id": 376},{"first_name": "Gerhard","id": 451},{"first_name": "Gerry","id": 191},{"first_name": "Gilbert","id": 741},{"first_name": "Gilberto","id": 166},{"first_name": "Hermann","id": 382},{"first_name": "Herta","id": 51},{"first_name": "Hertha","id": 328},{"first_name": "Hunter","id": 655},{"first_name": "Javier","id": 561},{"first_name": "Jenifer","id": 939},{"first_name": "Jennyfer","id": 924},{"first_name": "Jermaine","id": 204},{"first_name": "Jermaine","id": 252},{"first_name": "Jermey","id": 584},{"first_name": "Jeromy","id": 491},{"first_name": "Jerrell","id": 10},{"first_name": "Jerrell","id": 726},{"first_name": "Jerrod","id": 46},{"first_name": "Jerrod","id": 49},{"first_name": "Jerrod","id": 424},{"first_name": "Jerrold","id": 0},{"first_name": "Jerry","id": 556},{"first_name": "Jerry","id": 712},{"first_name": "Kameron","id": 83},{"first_name": "Katherine","id": 965},{"first_name": "Katheryn","id": 697},{"first_name": "Kiera","id": 371},{"first_name": "Laverna","id": 285},{"first_name": "Maverick","id": 28},{"first_name": "Maverick","id": 453},{"first_name": "Meredith","id": 136},{"first_name": "Meredith","id": 686},{"first_name": "Mervin","id": 146},{"first_name": "Norbert","id": 546},{"first_name": "Norbert","id": 961},{"first_name": "Perry","id": 560},{"first_name": "Pierce","id": 74},{"first_name": "Piper","id": 218},{"first_name": "Porter","id": 581},{"first_name": "Roderick","id": 745},{"first_name": "Rodger","id": 417},{"first_name": "Rupert","id": 282},{"first_name": "Schuyler","id": 174},{"first_name": "Sheridan","id": 653},{"first_name": "Spencer","id": 67},{"first_name": "Spencer","id": 851},{"first_name": "Sylvester","id": 423},{"first_name": "Tanner","id": 830},{"first_name": "Terence","id": 868},{"first_name": "Teresa","id": 779},{"first_name": "Teresa","id": 864},{"first_name": "Terrance","id": 95},{"first_name": "Terrance","id": 461},{"first_name": "Theresia","id": 314},{"first_name": "Verlie","id": 938},{"first_name": "Vern","id": 291},{"first_name": "Verna","id": 516},{"first_name": "Verner","id": 848},{"first_name": "Vernon","id": 570},{"first_name": "Webster","id": 470},{"first_name": "Xander","id": 18},{"first_name": "Zachery","id": 645},{"first_name": "Zackery","id": 393},{"first_name": "Zackery","id": 398}]];

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'first_name', 'er', false, undefined, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 74);
        assert.deepEqual(results[1].length, 74);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name limit 20 offset 20", () => {
        let expected = [[349,108,475,908,809,21,223,199,92,376,451,191,741,166,382,51,328,655,561,939],[{"first_name": "Everardo","id": 349},{"first_name": "Everette","id": 108},{"first_name": "Everette","id": 475},{"first_name": "Everette","id": 908},{"first_name": "Ferne","id": 809},{"first_name": "Frederik","id": 21},{"first_name": "Frederik","id": 223},{"first_name": "Gerard","id": 199},{"first_name": "Gerhard","id": 92},{"first_name": "Gerhard","id": 376},{"first_name": "Gerhard","id": 451},{"first_name": "Gerry","id": 191},{"first_name": "Gilbert","id": 741},{"first_name": "Gilberto","id": 166},{"first_name": "Hermann","id": 382},{"first_name": "Herta","id": 51},{"first_name": "Hertha","id": 328},{"first_name": "Hunter","id": 655},{"first_name": "Javier","id": 561},{"first_name": "Jenifer","id": 939}]];

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'first_name', 'er', false, 20, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 20);
        assert.deepEqual(results[1].length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse", () => {
        let expected = [[393,398,645,18,470,570,848,516,291,938,314,95,461,779,864,868,830,423,67,851,653,174,282,417,745,581,218,74,560,546,961,146,136,686,28,453,285,371,697,965,83,556,712,0,46,49,424,10,726,491,584,204,252,924,939,561,655,328,51,382,166,741,191,92,376,451,199,21,223,809,108,475,908,349,230,175,979,14,306,465,935,707,612,161,646,790,127,740,679,75,858,523,662,518],[{"first_name": "Zackery","id": 393},{"first_name": "Zackery","id": 398},{"first_name": "Zachery","id": 645},{"first_name": "Xander","id": 18},{"first_name": "Webster","id": 470},{"first_name": "Vernon","id": 570},{"first_name": "Verner","id": 848},{"first_name": "Verna","id": 516},{"first_name": "Vern","id": 291},{"first_name": "Verlie","id": 938},{"first_name": "Theresia","id": 314},{"first_name": "Terrance","id": 95},{"first_name": "Terrance","id": 461},{"first_name": "Teresa","id": 779},{"first_name": "Teresa","id": 864},{"first_name": "Terence","id": 868},{"first_name": "Tanner","id": 830},{"first_name": "Sylvester","id": 423},{"first_name": "Spencer","id": 67},{"first_name": "Spencer","id": 851},{"first_name": "Sheridan","id": 653},{"first_name": "Schuyler","id": 174},{"first_name": "Rupert","id": 282},{"first_name": "Rodger","id": 417},{"first_name": "Roderick","id": 745},{"first_name": "Porter","id": 581},{"first_name": "Piper","id": 218},{"first_name": "Pierce","id": 74},{"first_name": "Perry","id": 560},{"first_name": "Norbert","id": 546},{"first_name": "Norbert","id": 961},{"first_name": "Mervin","id": 146},{"first_name": "Meredith","id": 136},{"first_name": "Meredith","id": 686},{"first_name": "Maverick","id": 28},{"first_name": "Maverick","id": 453},{"first_name": "Laverna","id": 285},{"first_name": "Kiera","id": 371},{"first_name": "Katheryn","id": 697},{"first_name": "Katherine","id": 965},{"first_name": "Kameron","id": 83},{"first_name": "Jerry","id": 556},{"first_name": "Jerry","id": 712},{"first_name": "Jerrold","id": 0},{"first_name": "Jerrod","id": 46},{"first_name": "Jerrod","id": 49},{"first_name": "Jerrod","id": 424},{"first_name": "Jerrell","id": 10},{"first_name": "Jerrell","id": 726},{"first_name": "Jeromy","id": 491},{"first_name": "Jermey","id": 584},{"first_name": "Jermaine","id": 204},{"first_name": "Jermaine","id": 252},{"first_name": "Jennyfer","id": 924},{"first_name": "Jenifer","id": 939},{"first_name": "Javier","id": 561},{"first_name": "Hunter","id": 655},{"first_name": "Hertha","id": 328},{"first_name": "Herta","id": 51},{"first_name": "Hermann","id": 382},{"first_name": "Gilberto","id": 166},{"first_name": "Gilbert","id": 741},{"first_name": "Gerry","id": 191},{"first_name": "Gerhard","id": 92},{"first_name": "Gerhard","id": 376},{"first_name": "Gerhard","id": 451},{"first_name": "Gerard","id": 199},{"first_name": "Frederik","id": 21},{"first_name": "Frederik","id": 223},{"first_name": "Ferne","id": 809},{"first_name": "Everette","id": 108},{"first_name": "Everette","id": 475},{"first_name": "Everette","id": 908},{"first_name": "Everardo","id": 349},{"first_name": "Derrick","id": 230},{"first_name": "Deron","id": 175},{"first_name": "Delbert","id": 979},{"first_name": "Cierra","id": 14},{"first_name": "Cierra","id": 306},{"first_name": "Cicero","id": 465},{"first_name": "Casper","id": 935},{"first_name": "Buster","id": 707},{"first_name": "Beryl","id": 612},{"first_name": "Berta","id": 161},{"first_name": "Bernice","id": 646},{"first_name": "Bernice","id": 790},{"first_name": "Bernardo","id": 127},{"first_name": "Avery","id": 740},{"first_name": "Anderson","id": 679},{"first_name": "Alverta","id": 75},{"first_name": "Alvera","id": 858},{"first_name": "Albert","id": 523},{"first_name": "Adelbert","id": 662},{"first_name": "Abner","id": 518}]];

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'first_name', 'er', true], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 94);
        assert.deepEqual(results[1].length, 94);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse limit 20", () => {
        let expected = [[393,398,645,18,470,570,848,516,291,938,314,95,461,779,864,868,830,423,67,851],[{"first_name": "Zackery","id": 393},{"first_name": "Zackery","id": 398},{"first_name": "Zachery","id": 645},{"first_name": "Xander","id": 18},{"first_name": "Webster","id": 470},{"first_name": "Vernon","id": 570},{"first_name": "Verner","id": 848},{"first_name": "Verna","id": 516},{"first_name": "Vern","id": 291},{"first_name": "Verlie","id": 938},{"first_name": "Theresia","id": 314},{"first_name": "Terrance","id": 95},{"first_name": "Terrance","id": 461},{"first_name": "Teresa","id": 779},{"first_name": "Teresa","id": 864},{"first_name": "Terence","id": 868},{"first_name": "Tanner","id": 830},{"first_name": "Sylvester","id": 423},{"first_name": "Spencer","id": 67},{"first_name": "Spencer","id": 851}]];

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'first_name', 'er', true, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 20);
        assert.deepEqual(results[1].length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse offset 20", () => {
        let expected = [[653,174,282,417,745,581,218,74,560,546,961,146,136,686,28,453,285,371,697,965,83,556,712,0,46,49,424,10,726,491,584,204,252,924,939,561,655,328,51,382,166,741,191,92,376,451,199,21,223,809,108,475,908,349,230,175,979,14,306,465,935,707,612,161,646,790,127,740,679,75,858,523,662,518],[{"first_name": "Sheridan","id": 653},{"first_name": "Schuyler","id": 174},{"first_name": "Rupert","id": 282},{"first_name": "Rodger","id": 417},{"first_name": "Roderick","id": 745},{"first_name": "Porter","id": 581},{"first_name": "Piper","id": 218},{"first_name": "Pierce","id": 74},{"first_name": "Perry","id": 560},{"first_name": "Norbert","id": 546},{"first_name": "Norbert","id": 961},{"first_name": "Mervin","id": 146},{"first_name": "Meredith","id": 136},{"first_name": "Meredith","id": 686},{"first_name": "Maverick","id": 28},{"first_name": "Maverick","id": 453},{"first_name": "Laverna","id": 285},{"first_name": "Kiera","id": 371},{"first_name": "Katheryn","id": 697},{"first_name": "Katherine","id": 965},{"first_name": "Kameron","id": 83},{"first_name": "Jerry","id": 556},{"first_name": "Jerry","id": 712},{"first_name": "Jerrold","id": 0},{"first_name": "Jerrod","id": 46},{"first_name": "Jerrod","id": 49},{"first_name": "Jerrod","id": 424},{"first_name": "Jerrell","id": 10},{"first_name": "Jerrell","id": 726},{"first_name": "Jeromy","id": 491},{"first_name": "Jermey","id": 584},{"first_name": "Jermaine","id": 204},{"first_name": "Jermaine","id": 252},{"first_name": "Jennyfer","id": 924},{"first_name": "Jenifer","id": 939},{"first_name": "Javier","id": 561},{"first_name": "Hunter","id": 655},{"first_name": "Hertha","id": 328},{"first_name": "Herta","id": 51},{"first_name": "Hermann","id": 382},{"first_name": "Gilberto","id": 166},{"first_name": "Gilbert","id": 741},{"first_name": "Gerry","id": 191},{"first_name": "Gerhard","id": 92},{"first_name": "Gerhard","id": 376},{"first_name": "Gerhard","id": 451},{"first_name": "Gerard","id": 199},{"first_name": "Frederik","id": 21},{"first_name": "Frederik","id": 223},{"first_name": "Ferne","id": 809},{"first_name": "Everette","id": 108},{"first_name": "Everette","id": 475},{"first_name": "Everette","id": 908},{"first_name": "Everardo","id": 349},{"first_name": "Derrick","id": 230},{"first_name": "Deron","id": 175},{"first_name": "Delbert","id": 979},{"first_name": "Cierra","id": 14},{"first_name": "Cierra","id": 306},{"first_name": "Cicero","id": 465},{"first_name": "Casper","id": 935},{"first_name": "Buster","id": 707},{"first_name": "Beryl","id": 612},{"first_name": "Berta","id": 161},{"first_name": "Bernice","id": 646},{"first_name": "Bernice","id": 790},{"first_name": "Bernardo","id": 127},{"first_name": "Avery","id": 740},{"first_name": "Anderson","id": 679},{"first_name": "Alverta","id": 75},{"first_name": "Alvera","id": 858},{"first_name": "Albert","id": 523},{"first_name": "Adelbert","id": 662},{"first_name": "Abner","id": 518}]];

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'first_name', 'er', true, undefined, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 74);
        assert.deepEqual(results[1].length, 74);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse offset 20 limit 20", () => {
        let expected = [[653,174,282,417,745,581,218,74,560,546,961,146,136,686,28,453,285,371,697,965],[{"first_name": "Sheridan","id": 653},{"first_name": "Schuyler","id": 174},{"first_name": "Rupert","id": 282},{"first_name": "Rodger","id": 417},{"first_name": "Roderick","id": 745},{"first_name": "Porter","id": 581},{"first_name": "Piper","id": 218},{"first_name": "Pierce","id": 74},{"first_name": "Perry","id": 560},{"first_name": "Norbert","id": 546},{"first_name": "Norbert","id": 961},{"first_name": "Mervin","id": 146},{"first_name": "Meredith","id": 136},{"first_name": "Meredith","id": 686},{"first_name": "Maverick","id": 28},{"first_name": "Maverick","id": 453},{"first_name": "Laverna","id": 285},{"first_name": "Kiera","id": 371},{"first_name": "Katheryn","id": 697},{"first_name": "Katherine","id": 965}]];

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'first_name', 'er', true, 20, 20], undefined, 'all arguments');
        assert.deepEqual(results[0].length, 20);
        assert.deepEqual(results[1].length, 20);
        assert.deepEqual(results, expected);
    });
});