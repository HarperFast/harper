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
const LMDB_TEST_ERRORS = require('../../commonTestErrors').LMDB_ERRORS_ENUM;
const common_utils = require('../../../utility/common_utils');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'lmdbTest');
const TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';
const SOME_ATTRIBUTES = ['id', 'name', 'age'];
const All_ATTRIBUTES = ['id', 'name', 'age', 'city'];

const PERSON_ATTRIBUTES = ['id', 'first_name', 'state', 'age', 'alive', 'birth_month'];

const TIMESTAMP = Date.now();

describe('Test searchUtility module with limit & offset', ()=>{
    let date_stub;
    let indices = {
        id:{},
        first_name:{},
        state:{},
        age:{},
        alive:{},
        birth_month:{}
    };
    before(()=> {

        test_data.forEach(record=>{
            let id = record.id;
            Object.keys(record).forEach(key=>{
                let value = record[key];
                if(key === 'id'){
                    indices.id[id] = record;
                } else {
                    if(indices[key][value] === undefined){
                        indices[key][value] = {};
                    }
                    indices[key][value][id] = {id: id, [key]:value};
                }
            });
        });

        /*Object.keys(indices).forEach(key=>{
            if(key !== 'id'){
                Object.keys(indices[key]).forEach(i_key=>{
                    indices[key][i_key] = indices[key][i_key].sort((a, b)=>a - b);
                });
            }
        });*/

        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
    });

    after(()=> {
        date_stub.restore();
    });

    describe('test searchAll function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, true);
            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(PERSON_ATTRIBUTES), test_utils.deepClone(test_data));
        });

        after(async () => {
            env.close();
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("searchAll rows limit 100", ()=>{
            let rows = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, PERSON_ATTRIBUTES, false, 100], undefined, 'search');

            let expected = test_data.slice(0, 100);

            assert.deepEqual(rows, expected);
        });

        it("searchAll rows offset 100, limit 20", ()=>{
            let rows = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, PERSON_ATTRIBUTES,false, 20, 100], undefined, 'search');

            let expected = test_data.slice(100, 120);
            assert.deepEqual(rows, expected);
        });

        it("searchAll rows reverse limit 100", ()=>{
            let rows = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, PERSON_ATTRIBUTES, true, 100], undefined, 'search');

            let expected = test_data.slice(900, 1000);

            assert.deepEqual(rows, expected);
        });

        it("searchAll rows offset reverse 100, limit 20", ()=>{
            let rows = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, PERSON_ATTRIBUTES,true, 20, 100], undefined, 'search');

            let expected = test_data.slice(880, 900);
            assert.deepEqual(rows, expected);
        });
    });

    describe('test searchAllToMap function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(PERSON_ATTRIBUTES), test_utils.deepClone(test_data));
        });

        after(async () => {
            env.close();
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("searchAllToMap rows limit 100", ()=>{
            let rows = test_utils.assertErrorSync(search_util.searchAllToMap, [env, HASH_ATTRIBUTE_NAME, PERSON_ATTRIBUTES, false, 100], undefined, 'search');

            let expected = Object.create(null);
            for(let x = 0; x <100; x++){
                expected[x] = test_utils.assignObjecttoNullObject(test_data[x]);
            }

            assert.deepStrictEqual(rows, expected);
        });

        it("searchAllToMap rows limit 20 offset 100" , ()=>{
            let rows = test_utils.assertErrorSync(search_util.searchAllToMap, [env, HASH_ATTRIBUTE_NAME, PERSON_ATTRIBUTES, false, 20, 100], undefined, 'search');

            let expected = Object.create(null);
            for(let x = 100; x <120; x++){
                expected[x] = test_utils.assignObjecttoNullObject(test_data[x]);
            }

            assert.deepStrictEqual(rows, expected);
        });

        it("searchAllToMap rows reverse limit 100", ()=>{
            let rows = test_utils.assertErrorSync(search_util.searchAllToMap, [env, HASH_ATTRIBUTE_NAME, PERSON_ATTRIBUTES, true, 100], undefined, 'search');

            let expected = Object.create(null);
            for(let x = 999; x >= 900; x--){
                expected[x] = test_utils.assignObjecttoNullObject(test_data[x]);
            }

            assert.deepStrictEqual(rows, expected);
        });

        it("searchAllToMap rows reverse limit 20 offset 100" , ()=>{
            let rows = test_utils.assertErrorSync(search_util.searchAllToMap, [env, HASH_ATTRIBUTE_NAME, PERSON_ATTRIBUTES, true, 20, 100], undefined, 'search');

            let expected = Object.create(null);
            for(let x = 899; x >= 880; x--){
                expected[x] = test_utils.assignObjecttoNullObject(test_data[x]);
            }

            assert.deepStrictEqual(rows, expected);
        });
    });

    describe('test equals function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, true);
            await environment_utility.createDBI(env, 'age', true, false);
            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(PERSON_ATTRIBUTES), test_utils.deepClone(test_data));
        });

        after(async () => {
            env.close();
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test search on state limit 10", () => {
            let expected = {"58":{"id":58,"state":"CO"},"60":{"id":60,"state":"CO"},"83":{"id":83,"state":"CO"},"88":{"id":88,"state":"CO"},"172":{"id":172,"state":"CO"},"224":{"id":224,"state":"CO"},"229":{"id":229,"state":"CO"},"330":{"id":330,"state":"CO"},"384":{"id":384,"state":"CO"},"418":{"id":418,"state":"CO"}}

            let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'state', 'CO', false, 10], undefined, 'all arguments');
            assert.deepEqual(results, expected);
        });

        it("test search on state, limit 1000", () => {
            let expected = {"58":{"state":"CO"},"60":{"state":"CO"},"83":{"state":"CO"},"88":{"state":"CO"},"172":{"state":"CO"},"224":{"state":"CO"},"229":{"state":"CO"},"330":{"state":"CO"},"384":{"state":"CO"},"418":{"state":"CO"},"481":{"state":"CO"},"521":{"state":"CO"},"611":{"state":"CO"},"644":{"state":"CO"},"658":{"state":"CO"},"701":{"state":"CO"},"943":{"state":"CO"},"946":{"state":"CO"},"967":{"state":"CO"}};

            let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', false, 1000], undefined, 'all arguments');
            assert.deepEqual(results, expected);
        });

        it("test search on state, offset 10 limit 5", () => {
            let expected = {"481":{"state":"CO"},"521":{"state":"CO"},"611":{"state":"CO"},"644":{"state":"CO"},"658":{"state":"CO"}};
            /*let expected = Object.create(null);

            let index = indices.state.CO;
            let keys = Object.keys(index);

            for(let x = 10; keys[x] !== undefined && x < 15; x++){
                let key = keys[x];
                let obj = index[key];
                delete obj.id;
                expected[key] = test_utils.assignObjecttoNullObject(obj);
            }*/

            let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', false, 5, 10], undefined, 'all arguments');
            assert.deepEqual(results, expected);
        });

        it("test search on state, offset 1000 limit 5", () => {
            let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', false, 5, 1000], undefined, 'all arguments');
            assert.deepEqual(results, {});
        });

        it("test search on state reverse limit 10", () => {
            let expected = {"418":{"id":418,"state":"CO"},"481":{"id":481,"state":"CO"},"521":{"id":521,"state":"CO"},"611":{"id":611,"state":"CO"},"644":{"id":644,"state":"CO"},"658":{"id":658,"state":"CO"},"701":{"id":701,"state":"CO"},"943":{"id":943,"state":"CO"},"946":{"id":946,"state":"CO"},"967":{"id":967,"state":"CO"}};

            let results = test_utils.assertErrorSync(search_util.equals, [env, 'id', 'state', 'CO', true, 10], undefined, 'all arguments');
            assert.deepEqual(results, expected);
        });

        it("test search on state, reverse, limit 1000", () => {
            let expected = {"58":{"state":"CO"},"60":{"state":"CO"},"83":{"state":"CO"},"88":{"state":"CO"},"172":{"state":"CO"},"224":{"state":"CO"},"229":{"state":"CO"},"330":{"state":"CO"},"384":{"state":"CO"},"418":{"state":"CO"},"481":{"state":"CO"},"521":{"state":"CO"},"611":{"state":"CO"},"644":{"state":"CO"},"658":{"state":"CO"},"701":{"state":"CO"},"943":{"state":"CO"},"946":{"state":"CO"},"967":{"state":"CO"}};

            let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', true, 1000], undefined, 'all arguments');
            assert.deepEqual(results, expected);
        });

        it("test search on state, reverse offset 10 limit 5", () => {
            let expected = {"172":{"state":"CO"},"224":{"state":"CO"},"229":{"state":"CO"},"330":{"state":"CO"},"384":{"state":"CO"}};
            /*let expected = Object.create(null);

            let index = indices.state.CO;
            let keys = Object.keys(index);

            for(let x = keys.length - 11; keys[x] !== undefined && x >= keys.length - 15; x--){
                let key = keys[x];
                let obj = index[key];
                delete obj.id;
                expected[key] = test_utils.assignObjecttoNullObject(obj);
            }*/

            let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', true, 5, 10], undefined, 'all arguments');
            assert.deepEqual(results, expected);
        });

        it("test search on state, reverse offset 1000 limit 5", () => {
            let results = test_utils.assertErrorSync(search_util.equals, [env, undefined, 'state', 'CO', true, 5, 1000], undefined, 'all arguments');
            assert.deepEqual(results, {});
        });
    });

    describe('test startsWith function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, true);
            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(PERSON_ATTRIBUTES), test_utils.deepClone(test_data));
        });

        after(async () => {
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

        it("test search on first_name offset 10 limit 20", () => {
            let expected = {"62":{"first_name":"Maria","id":62},"86":{"first_name":"Marisol","id":86},"106":{"first_name":"Marquise","id":106},"145":{"first_name":"Mariano","id":145},"156":{"first_name":"Maryse","id":156},"500":{"first_name":"Marlee","id":500},"555":{"first_name":"Mariela","id":555},"563":{"first_name":"Marquis","id":563},"650":{"first_name":"Mark","id":650},"738":{"first_name":"Marques","id":738},"739":{"first_name":"Maribel","id":739},"770":{"first_name":"Marty","id":770},"777":{"first_name":"Marjolaine","id":777},"877":{"first_name":"Mariah","id":877},"882":{"first_name":"Marlin","id":882}};

            let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', false, 20, 10], undefined, 'all arguments');
            assert.deepStrictEqual(Object.keys(results).length, 15);
            assert.deepEqual(results, expected);
        });

        it("test search on first_name reverse limit 15", () => {
            let expected = {"62":{"first_name":"Maria","id":62},"86":{"first_name":"Marisol","id":86},"106":{"first_name":"Marquise","id":106},"145":{"first_name":"Mariano","id":145},"156":{"first_name":"Maryse","id":156},"500":{"first_name":"Marlee","id":500},"555":{"first_name":"Mariela","id":555},"563":{"first_name":"Marquis","id":563},"650":{"first_name":"Mark","id":650},"738":{"first_name":"Marques","id":738},"739":{"first_name":"Maribel","id":739},"770":{"first_name":"Marty","id":770},"777":{"first_name":"Marjolaine","id":777},"877":{"first_name":"Mariah","id":877},"882":{"first_name":"Marlin","id":882}};

            let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', true, 15], undefined, 'all arguments');
            assert.deepStrictEqual(Object.keys(results).length, 15);
            assert.deepEqual(results, expected);
        });

        it("test search on first_name reverse offset 10 limit 20", () => {
            let expected = {"17":{"first_name":"Margarita","id":17},"62":{"first_name":"Maria","id":62},"145":{"first_name":"Mariano","id":145},"265":{"first_name":"Margarita","id":265},"278":{"first_name":"Marcus","id":278},"555":{"first_name":"Mariela","id":555},"586":{"first_name":"Marcellus","id":586},"739":{"first_name":"Maribel","id":739},"764":{"first_name":"Margaret","id":764},"805":{"first_name":"Margot","id":805},"877":{"first_name":"Mariah","id":877},"880":{"first_name":"Marco","id":880},"884":{"first_name":"Marc","id":884},"936":{"first_name":"Marcia","id":936},"966":{"first_name":"Mara","id":966}};

            let results = test_utils.assertErrorSync(search_util.startsWith, [env, 'id', 'first_name', 'Mar', true, 20, 10], undefined, 'all arguments');
            assert.deepStrictEqual(Object.keys(results).length, 15);
            assert.deepEqual(results, expected);
        });
    });

    describe('test endsWith function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, true);
            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(PERSON_ATTRIBUTES), test_utils.deepClone(test_data));
        });

        after(async () => {
            env.close();
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test search on first_name limit 10", () => {
            let expected = {"19":{"first_name":"Delphia","id":19},"270":{"first_name":"Alexandria","id":270},"301":{"first_name":"Emilia","id":301},"538":{"first_name":"Delia","id":538},"545":{"first_name":"Alia","id":545},"621":{"first_name":"Cecilia","id":621},"669":{"first_name":"Adelia","id":669},"795":{"first_name":"Dahlia","id":795},"876":{"first_name":"Bria","id":876},"898":{"first_name":"Asia","id":898}};
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', false, 10], undefined, 'all arguments');
            assert.deepEqual(results, expected);
        });

        it("test search on first_name limit 10 offset 10", () => {
            let expected = {"62":{"first_name":"Maria","id":62},"268":{"first_name":"Gia","id":268},"425":{"first_name":"Lelia","id":425},"450":{"first_name":"Shania","id":450},"625":{"first_name":"Estefania","id":625},"685":{"first_name":"Gregoria","id":685},"692":{"first_name":"Otilia","id":692},"871":{"first_name":"Magnolia","id":871},"936":{"first_name":"Marcia","id":936},"968":{"first_name":"Eugenia","id":968}};
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', false, 10, 10], undefined, 'all arguments');
            assert.deepEqual(results, expected);
        });

        it("test search on first_name reverse limit 10", () => {
            let expected = {"62":{"first_name":"Maria","id":62},"151":{"first_name":"Sofia","id":151},"186":{"first_name":"Thalia","id":186},"314":{"first_name":"Theresia","id":314},"450":{"first_name":"Shania","id":450},"467":{"first_name":"Zaria","id":467},"508":{"first_name":"Thalia","id":508},"692":{"first_name":"Otilia","id":692},"901":{"first_name":"Trycia","id":901},"922":{"first_name":"Thalia","id":922}};
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', true, 10], undefined, 'all arguments');
            assert.deepEqual(results, expected);
        });

        it("test search on first_name reverse limit 10 offset 10", () => {
            let expected = {"19":{"first_name":"Delphia","id":19},"268":{"first_name":"Gia","id":268},"301":{"first_name":"Emilia","id":301},"425":{"first_name":"Lelia","id":425},"538":{"first_name":"Delia","id":538},"625":{"first_name":"Estefania","id":625},"685":{"first_name":"Gregoria","id":685},"871":{"first_name":"Magnolia","id":871},"936":{"first_name":"Marcia","id":936},"968":{"first_name":"Eugenia","id":968}};
            let results = test_utils.assertErrorSync(search_util.endsWith, [env, 'id', 'first_name', 'ia', true, 10, 10], undefined, 'all arguments');
            assert.deepEqual(results, expected);
        });
    });

    describe('test greaterThan function', ()=> {
        let env;

        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, true);

            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(PERSON_ATTRIBUTES), test_utils.deepClone(test_data));
        });

        after(async () => {
            env.close();
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        /** TEST HASH ATTRIBUTE **/
        it("test greater than 100 on hash column limit 20", () => {
            let expected = {"101":{"id":101},"102":{"id":102},"103":{"id":103},"104":{"id":104},"105":{"id":105},"106":{"id":106},"107":{"id":107},"108":{"id":108},"109":{"id":109},"110":{"id":110},"111":{"id":111},"112":{"id":112},"113":{"id":113},"114":{"id":114},"115":{"id":115},"116":{"id":116},"117":{"id":117},"118":{"id":118},"119":{"id":119},"120":{"id":120}};

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'id', 100, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test greater than 100 on hash column limit 20 offset 20", () => {
            let expected = {"121":{"id":121},"122":{"id":122},"123":{"id":123},"124":{"id":124},"125":{"id":125},"126":{"id":126},"127":{"id":127},"128":{"id":128},"129":{"id":129},"130":{"id":130},"131":{"id":131},"132":{"id":132},"133":{"id":133},"134":{"id":134},"135":{"id":135},"136":{"id":136},"137":{"id":137},"138":{"id":138},"139":{"id":139},"140":{"id":140}};

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'id', 100, 20, 20], undefined);

            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });


        it("test greater than 83 on age limit 20", () => {
            let expected = {"45":{"age":85,"id":45},"68":{"age":85,"id":68},"75":{"age":84,"id":75},"90":{"age":86,"id":90},"107":{"age":84,"id":107},"183":{"age":86,"id":183},"235":{"age":85,"id":235},"245":{"age":84,"id":245},"276":{"age":86,"id":276},"316":{"age":84,"id":316},"336":{"age":85,"id":336},"519":{"age":84,"id":519},"633":{"age":85,"id":633},"682":{"age":84,"id":682},"703":{"age":85,"id":703},"828":{"age":85,"id":828},"913":{"age":84,"id":913},"951":{"age":84,"id":951},"968":{"age":85,"id":968},"969":{"age":84,"id":969}};

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'age', 83, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test greater than 83 on age limit 20 offset 20", () => {
            let expected = {"30":{"age":88,"id":30},"53":{"age":87,"id":53},"65":{"age":88,"id":65},"87":{"age":87,"id":87},"114":{"age":88,"id":114},"267":{"age":88,"id":267},"330":{"age":87,"id":330},"337":{"age":86,"id":337},"385":{"age":87,"id":385},"405":{"age":86,"id":405},"437":{"age":87,"id":437},"446":{"age":87,"id":446},"469":{"age":86,"id":469},"497":{"age":87,"id":497},"723":{"age":87,"id":723},"753":{"age":86,"id":753},"807":{"age":87,"id":807},"817":{"age":87,"id":817},"818":{"age":87,"id":818},"895":{"age":87,"id":895}};

            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'age', 83, 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        /** STRING **/

        it("test greater than CO on string key column limit 20", () => {
            let expected = {"0":{"state":"CT","id":0},"12":{"state":"CT","id":12},"34":{"state":"CT","id":34},"69":{"state":"CT","id":69},"70":{"state":"CT","id":70},"142":{"state":"CT","id":142},"143":{"state":"CT","id":143},"153":{"state":"CT","id":153},"263":{"state":"CT","id":263},"309":{"state":"CT","id":309},"360":{"state":"CT","id":360},"383":{"state":"CT","id":383},"411":{"state":"CT","id":411},"423":{"state":"CT","id":423},"444":{"state":"CT","id":444},"497":{"state":"CT","id":497},"593":{"state":"CT","id":593},"671":{"state":"CT","id":671},"717":{"state":"CT","id":717},"896":{"state":"CT","id":896}};
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'state', 'CO', 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test greater than CO on string key column limit 20 offset 20", () => {
            let expected = {"8":{"state":"DC","id":8},"64":{"state":"DC","id":64},"222":{"state":"DC","id":222},"238":{"state":"DC","id":238},"353":{"state":"DC","id":353},"456":{"state":"DC","id":456},"464":{"state":"DC","id":464},"582":{"state":"DC","id":582},"598":{"state":"DC","id":598},"645":{"state":"DC","id":645},"652":{"state":"DC","id":652},"660":{"state":"DC","id":660},"713":{"state":"DC","id":713},"757":{"state":"DC","id":757},"764":{"state":"DC","id":764},"767":{"state":"DC","id":767},"888":{"state":"DC","id":888},"908":{"state":"CT","id":908},"912":{"state":"CT","id":912},"976":{"state":"CT","id":976}};
            let results = test_utils.assertErrorSync(search_util.greaterThan, [env, 'id', 'state', 'CO', 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });
    });

    describe('test greaterThanEqual function', ()=> {
        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, true);

            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(PERSON_ATTRIBUTES), test_utils.deepClone(test_data));
        });

        after(async () => {
            env.close();
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        /** TEST HASH ATTRIBUTE **/
        it("test greater than equal 100 on hash column limit 20", () => {
            let expected = {"100":{"id":100},"101":{"id":101},"102":{"id":102},"103":{"id":103},"104":{"id":104},"105":{"id":105},"106":{"id":106},"107":{"id":107},"108":{"id":108},"109":{"id":109},"110":{"id":110},"111":{"id":111},"112":{"id":112},"113":{"id":113},"114":{"id":114},"115":{"id":115},"116":{"id":116},"117":{"id":117},"118":{"id":118},"119":{"id":119}};

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'id', '100', 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test greater than equal 100 on hash column limit 20 offset 20", () => {
            let expected = {"120":{"id":120},"121":{"id":121},"122":{"id":122},"123":{"id":123},"124":{"id":124},"125":{"id":125},"126":{"id":126},"127":{"id":127},"128":{"id":128},"129":{"id":129},"130":{"id":130},"131":{"id":131},"132":{"id":132},"133":{"id":133},"134":{"id":134},"135":{"id":135},"136":{"id":136},"137":{"id":137},"138":{"id":138},"139":{"id":139}};

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'id', '100', 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });


        it("test greaterThanEqual 83 limit 20", () => {
            let expected = {"0":{"age":83,"id":0},"75":{"age":84,"id":75},"107":{"age":84,"id":107},"132":{"age":83,"id":132},"181":{"age":83,"id":181},"239":{"age":83,"id":239},"245":{"age":84,"id":245},"273":{"age":83,"id":273},"316":{"age":84,"id":316},"361":{"age":83,"id":361},"420":{"age":83,"id":420},"519":{"age":84,"id":519},"577":{"age":83,"id":577},"597":{"age":83,"id":597},"640":{"age":83,"id":640},"669":{"age":83,"id":669},"682":{"age":84,"id":682},"738":{"age":83,"id":738},"916":{"age":83,"id":916},"937":{"age":83,"id":937}};

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'age', '83', 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test greaterThanEqual 83 limit 20 offset 20", () => {
            let expected = {"45":{"age":85,"id":45},"53":{"age":87,"id":53},"68":{"age":85,"id":68},"87":{"age":87,"id":87},"90":{"age":86,"id":90},"183":{"age":86,"id":183},"235":{"age":85,"id":235},"276":{"age":86,"id":276},"336":{"age":85,"id":336},"337":{"age":86,"id":337},"405":{"age":86,"id":405},"469":{"age":86,"id":469},"633":{"age":85,"id":633},"703":{"age":85,"id":703},"753":{"age":86,"id":753},"828":{"age":85,"id":828},"913":{"age":84,"id":913},"951":{"age":84,"id":951},"968":{"age":85,"id":968},"969":{"age":84,"id":969}};

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'age', '83', 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        /** STRING **/
        it("test greater than equal CO on string key column limit 20", () => {
            let expected = {"0":{"state":"CT","id":0},"58":{"state":"CO","id":58},"60":{"state":"CO","id":60},"83":{"state":"CO","id":83},"88":{"state":"CO","id":88},"172":{"state":"CO","id":172},"224":{"state":"CO","id":224},"229":{"state":"CO","id":229},"330":{"state":"CO","id":330},"384":{"state":"CO","id":384},"418":{"state":"CO","id":418},"481":{"state":"CO","id":481},"521":{"state":"CO","id":521},"611":{"state":"CO","id":611},"644":{"state":"CO","id":644},"658":{"state":"CO","id":658},"701":{"state":"CO","id":701},"943":{"state":"CO","id":943},"946":{"state":"CO","id":946},"967":{"state":"CO","id":967}};

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'state', 'CO', 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test greater than equal CO on string key column limit 20 offset 20", () => {
            let expected = {"12":{"state":"CT","id":12},"34":{"state":"CT","id":34},"69":{"state":"CT","id":69},"70":{"state":"CT","id":70},"142":{"state":"CT","id":142},"143":{"state":"CT","id":143},"153":{"state":"CT","id":153},"263":{"state":"CT","id":263},"309":{"state":"CT","id":309},"360":{"state":"CT","id":360},"383":{"state":"CT","id":383},"411":{"state":"CT","id":411},"423":{"state":"CT","id":423},"444":{"state":"CT","id":444},"497":{"state":"CT","id":497},"593":{"state":"CT","id":593},"671":{"state":"CT","id":671},"717":{"state":"CT","id":717},"896":{"state":"CT","id":896},"908":{"state":"CT","id":908}};

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'state', 'CO', 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test greater than equal W on string key column limit 20", () => {
            let expected = {"79":{"state":"WA","id":79},"109":{"state":"WA","id":109},"150":{"state":"WA","id":150},"197":{"state":"WA","id":197},"199":{"state":"WA","id":199},"228":{"state":"WA","id":228},"241":{"state":"WA","id":241},"250":{"state":"WA","id":250},"345":{"state":"WA","id":345},"451":{"state":"WA","id":451},"525":{"state":"WA","id":525},"542":{"state":"WA","id":542},"572":{"state":"WA","id":572},"683":{"state":"WA","id":683},"711":{"state":"WA","id":711},"738":{"state":"WA","id":738},"779":{"state":"WA","id":779},"860":{"state":"WA","id":860},"878":{"state":"WA","id":878},"938":{"state":"WA","id":938}};

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'state', 'W', 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test greater than equal W on string key column limit 20 offset 20", () => {
            let expected = {"33":{"state":"WV","id":33},"100":{"state":"WV","id":100},"155":{"state":"WV","id":155},"196":{"state":"WI","id":196},"201":{"state":"WI","id":201},"275":{"state":"WI","id":275},"434":{"state":"WI","id":434},"471":{"state":"WI","id":471},"498":{"state":"WI","id":498},"502":{"state":"WI","id":502},"537":{"state":"WI","id":537},"624":{"state":"WI","id":624},"672":{"state":"WI","id":672},"686":{"state":"WI","id":686},"712":{"state":"WI","id":712},"739":{"state":"WI","id":739},"750":{"state":"WI","id":750},"824":{"state":"WI","id":824},"866":{"state":"WI","id":866},"969":{"state":"WA","id":969}};

            let results = test_utils.assertErrorSync(search_util.greaterThanEqual, [env, 'id', 'state', 'W', 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

    });

    describe('test lessThan function', ()=> {

        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, true);

            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(PERSON_ATTRIBUTES), test_utils.deepClone(test_data));
        });

        after(async () => {
            env.close();
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        /** TEST HASH ATTRIBUTE **/
        it("test lessThan 100 on hash column limit 20", () => {
            let expected = {"80":{"id":80},"81":{"id":81},"82":{"id":82},"83":{"id":83},"84":{"id":84},"85":{"id":85},"86":{"id":86},"87":{"id":87},"88":{"id":88},"89":{"id":89},"90":{"id":90},"91":{"id":91},"92":{"id":92},"93":{"id":93},"94":{"id":94},"95":{"id":95},"96":{"id":96},"97":{"id":97},"98":{"id":98},"99":{"id":99}};

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'id', '100', 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test lessThan 100 on hash column limit 20 offset 20", () => {
            let expected = {"60":{"id":60},"61":{"id":61},"62":{"id":62},"63":{"id":63},"64":{"id":64},"65":{"id":65},"66":{"id":66},"67":{"id":67},"68":{"id":68},"69":{"id":69},"70":{"id":70},"71":{"id":71},"72":{"id":72},"73":{"id":73},"74":{"id":74},"75":{"id":75},"76":{"id":76},"77":{"id":77},"78":{"id":78},"79":{"id":79}};

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'id', '100', 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        /**number**/

        it("test lessThan 83 on age limit 20", () => {
            let expected = {"8":{"age":82,"id":8},"154":{"age":82,"id":154},"270":{"age":82,"id":270},"394":{"age":81,"id":394},"403":{"age":82,"id":403},"441":{"age":81,"id":441},"529":{"age":82,"id":529},"569":{"age":82,"id":569},"570":{"age":81,"id":570},"583":{"age":82,"id":583},"687":{"age":82,"id":687},"698":{"age":82,"id":698},"752":{"age":82,"id":752},"756":{"age":82,"id":756},"819":{"age":81,"id":819},"879":{"age":81,"id":879},"905":{"age":82,"id":905},"923":{"age":81,"id":923},"959":{"age":82,"id":959},"963":{"age":81,"id":963}};

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'age', 83, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test lessThan 83 on age limit 20 offset 20", () => {
            let expected = {"77":{"age":81,"id":77},"111":{"age":81,"id":111},"112":{"age":79,"id":112},"120":{"age":81,"id":120},"142":{"age":80,"id":142},"153":{"age":81,"id":153},"172":{"age":80,"id":172},"191":{"age":80,"id":191},"206":{"age":80,"id":206},"288":{"age":80,"id":288},"358":{"age":80,"id":358},"539":{"age":79,"id":539},"565":{"age":80,"id":565},"596":{"age":79,"id":596},"616":{"age":80,"id":616},"625":{"age":79,"id":625},"661":{"age":80,"id":661},"731":{"age":80,"id":731},"782":{"age":80,"id":782},"821":{"age":80,"id":821}};

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'age', 83, 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        /** STRING **/

        it("test lessThan CO on string key column limit 20", () =>{
            let expected = {"126":{"state":"CA","id":126},"219":{"state":"CA","id":219},"239":{"state":"CA","id":239},"254":{"state":"CA","id":254},"262":{"state":"CA","id":262},"358":{"state":"CA","id":358},"421":{"state":"CA","id":421},"455":{"state":"CA","id":455},"484":{"state":"CA","id":484},"504":{"state":"CA","id":504},"604":{"state":"CA","id":604},"607":{"state":"CA","id":607},"668":{"state":"CA","id":668},"726":{"state":"CA","id":726},"744":{"state":"CA","id":744},"904":{"state":"CA","id":904},"944":{"state":"CA","id":944},"951":{"state":"CA","id":951},"973":{"state":"CA","id":973},"996":{"state":"CA","id":996}};

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'state', 'CO', 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test lessThan CO on string key column limit 20 offset 20", () =>{
            let expected = {"44":{"state":"CA","id":44},"273":{"state":"AZ","id":273},"344":{"state":"AZ","id":344},"412":{"state":"AZ","id":412},"453":{"state":"AZ","id":453},"468":{"state":"AZ","id":468},"574":{"state":"AZ","id":574},"602":{"state":"AZ","id":602},"676":{"state":"AZ","id":676},"680":{"state":"AZ","id":680},"689":{"state":"AZ","id":689},"690":{"state":"AZ","id":690},"691":{"state":"AZ","id":691},"857":{"state":"AZ","id":857},"919":{"state":"AZ","id":919},"935":{"state":"AZ","id":935},"948":{"state":"AZ","id":948},"953":{"state":"AZ","id":953},"957":{"state":"AZ","id":957},"964":{"state":"AZ","id":964}};

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'state', 'CO', 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test lessThan W on string key column limit 20", () => {
            let expected = {"310":{"state":"VT","id":310},"340":{"state":"VT","id":340},"382":{"state":"VT","id":382},"409":{"state":"VT","id":409},"477":{"state":"VT","id":477},"505":{"state":"VT","id":505},"507":{"state":"VT","id":507},"509":{"state":"VT","id":509},"566":{"state":"VT","id":566},"571":{"state":"VT","id":571},"638":{"state":"VT","id":638},"650":{"state":"VT","id":650},"654":{"state":"VT","id":654},"667":{"state":"VT","id":667},"788":{"state":"VT","id":788},"821":{"state":"VT","id":821},"831":{"state":"VT","id":831},"835":{"state":"VT","id":835},"927":{"state":"VT","id":927},"994":{"state":"VT","id":994}};

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'state', 'W', 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test lessThan W on string key column limit 20 offset 20", () => {
            let expected = {"77":{"state":"VT","id":77},"203":{"state":"VT","id":203},"234":{"state":"VT","id":234},"303":{"state":"VT","id":303},"565":{"state":"VA","id":565},"588":{"state":"VA","id":588},"606":{"state":"VA","id":606},"609":{"state":"VA","id":609},"622":{"state":"VA","id":622},"655":{"state":"VA","id":655},"669":{"state":"VA","id":669},"678":{"state":"VA","id":678},"730":{"state":"VA","id":730},"776":{"state":"VA","id":776},"778":{"state":"VA","id":778},"838":{"state":"VA","id":838},"872":{"state":"VA","id":872},"926":{"state":"VA","id":926},"930":{"state":"VA","id":930},"958":{"state":"VA","id":958}};

            let results = test_utils.assertErrorSync(search_util.lessThan, [env, 'id', 'state', 'W', 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });
    });

    describe('test lessThanEqual function', ()=> {
        function createExpected(attribute, value){
            let expected = Object.create(null);

            for(let x = 0; x < test_data.length; x++){
                let attr_value = isNaN(test_data[x][attribute]) ? test_data[x][attribute] : Number(test_data[x][attribute]);
                if(attr_value <= value){
                    let id = test_data[x].id;
                    expected[id.toString()] = test_utils.assignObjecttoNullObject({id: Number(id)});
                    expected[id.toString()][attribute] = attr_value;
                }
            }

            return expected;
        }

        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, true);

            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(PERSON_ATTRIBUTES), test_utils.deepClone(test_data));
        });

        after(async () => {
            env.close();
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        /** TEST HASH ATTRIBUTE **/
        it("test lessThanEqual 100 on hash column limit 20", () => {
            let expected = {"81":{"id":81},"82":{"id":82},"83":{"id":83},"84":{"id":84},"85":{"id":85},"86":{"id":86},"87":{"id":87},"88":{"id":88},"89":{"id":89},"90":{"id":90},"91":{"id":91},"92":{"id":92},"93":{"id":93},"94":{"id":94},"95":{"id":95},"96":{"id":96},"97":{"id":97},"98":{"id":98},"99":{"id":99},"100":{"id":100}};

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'id', '100', 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test lessThanEqual 100 on hash column limit 20 offset 20", () => {
            let expected = {"61":{"id":61},"62":{"id":62},"63":{"id":63},"64":{"id":64},"65":{"id":65},"66":{"id":66},"67":{"id":67},"68":{"id":68},"69":{"id":69},"70":{"id":70},"71":{"id":71},"72":{"id":72},"73":{"id":73},"74":{"id":74},"75":{"id":75},"76":{"id":76},"77":{"id":77},"78":{"id":78},"79":{"id":79},"80":{"id":80}};

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'id', '100', 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test lessThanEqual 47 on age limit 20", () => {
            let expected = {"20":{"age":47,"id":20},"119":{"age":46,"id":119},"143":{"age":46,"id":143},"238":{"age":47,"id":238},"251":{"age":46,"id":251},"291":{"age":47,"id":291},"364":{"age":46,"id":364},"412":{"age":46,"id":412},"429":{"age":47,"id":429},"435":{"age":46,"id":435},"449":{"age":47,"id":449},"589":{"age":47,"id":589},"609":{"age":46,"id":609},"641":{"age":46,"id":641},"657":{"age":46,"id":657},"689":{"age":47,"id":689},"728":{"age":46,"id":728},"739":{"age":46,"id":739},"749":{"age":46,"id":749},"762":{"age":47,"id":762}};

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'age', 47, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test lessThanEqual 47 on age limit 20 offset 20", () => {
            let expected = {"92":{"age":44,"id":92},"96":{"age":45,"id":96},"110":{"age":45,"id":110},"244":{"age":43,"id":244},"248":{"age":44,"id":248},"281":{"age":45,"id":281},"339":{"age":43,"id":339},"350":{"age":45,"id":350},"377":{"age":44,"id":377},"632":{"age":43,"id":632},"659":{"age":44,"id":659},"692":{"age":42,"id":692},"714":{"age":43,"id":714},"768":{"age":44,"id":768},"806":{"age":45,"id":806},"883":{"age":43,"id":883},"894":{"age":42,"id":894},"901":{"age":42,"id":901},"910":{"age":42,"id":910},"977":{"age":45,"id":977}};

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'age', 47, 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        /** string **/
        it("test lessThanEqual CO on string key column limit 20", () => {
            let expected = {"58":{"state":"CO","id":58},"60":{"state":"CO","id":60},"83":{"state":"CO","id":83},"88":{"state":"CO","id":88},"172":{"state":"CO","id":172},"224":{"state":"CO","id":224},"229":{"state":"CO","id":229},"330":{"state":"CO","id":330},"384":{"state":"CO","id":384},"418":{"state":"CO","id":418},"481":{"state":"CO","id":481},"521":{"state":"CO","id":521},"611":{"state":"CO","id":611},"644":{"state":"CO","id":644},"658":{"state":"CO","id":658},"701":{"state":"CO","id":701},"943":{"state":"CO","id":943},"946":{"state":"CO","id":946},"967":{"state":"CO","id":967},"996":{"state":"CA","id":996}};

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'state', 'CO', 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test lessThanEqual CO on string key column limit 20 offset 20", () => {
            let expected = {"44":{"state":"CA","id":44},"126":{"state":"CA","id":126},"219":{"state":"CA","id":219},"239":{"state":"CA","id":239},"254":{"state":"CA","id":254},"262":{"state":"CA","id":262},"358":{"state":"CA","id":358},"421":{"state":"CA","id":421},"455":{"state":"CA","id":455},"484":{"state":"CA","id":484},"504":{"state":"CA","id":504},"604":{"state":"CA","id":604},"607":{"state":"CA","id":607},"668":{"state":"CA","id":668},"726":{"state":"CA","id":726},"744":{"state":"CA","id":744},"904":{"state":"CA","id":904},"944":{"state":"CA","id":944},"951":{"state":"CA","id":951},"973":{"state":"CA","id":973}};

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'state', 'CO', 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test lessThanEqual W on string key column limit 20", () => {
            let expected = {"310":{"state":"VT","id":310},"340":{"state":"VT","id":340},"382":{"state":"VT","id":382},"409":{"state":"VT","id":409},"477":{"state":"VT","id":477},"505":{"state":"VT","id":505},"507":{"state":"VT","id":507},"509":{"state":"VT","id":509},"566":{"state":"VT","id":566},"571":{"state":"VT","id":571},"638":{"state":"VT","id":638},"650":{"state":"VT","id":650},"654":{"state":"VT","id":654},"667":{"state":"VT","id":667},"788":{"state":"VT","id":788},"821":{"state":"VT","id":821},"831":{"state":"VT","id":831},"835":{"state":"VT","id":835},"927":{"state":"VT","id":927},"994":{"state":"VT","id":994}};

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'state', 'W', 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test lessThanEqual W on string key column limit 20 offseyt 20", () => {
            let expected = {"77":{"state":"VT","id":77},"203":{"state":"VT","id":203},"234":{"state":"VT","id":234},"303":{"state":"VT","id":303},"565":{"state":"VA","id":565},"588":{"state":"VA","id":588},"606":{"state":"VA","id":606},"609":{"state":"VA","id":609},"622":{"state":"VA","id":622},"655":{"state":"VA","id":655},"669":{"state":"VA","id":669},"678":{"state":"VA","id":678},"730":{"state":"VA","id":730},"776":{"state":"VA","id":776},"778":{"state":"VA","id":778},"838":{"state":"VA","id":838},"872":{"state":"VA","id":872},"926":{"state":"VA","id":926},"930":{"state":"VA","id":930},"958":{"state":"VA","id":958}};

            let results = test_utils.assertErrorSync(search_util.lessThanEqual, [env, 'id', 'state', 'W', 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });
    });

    describe('test between function', ()=> {
        function createExpected(attribute, start_value, end_value){
            let expected = Object.create(null);

            for(let x = 0; x < test_data.length; x++){
                let attr_value = isNaN(test_data[x][attribute]) ? test_data[x][attribute] : Number(test_data[x][attribute]);
                if(attr_value >= start_value && attr_value <= end_value){
                    let id = test_data[x].id;
                    expected[id.toString()] = test_utils.assignObjecttoNullObject({id: Number(id)});
                    expected[id.toString()][attribute] = attr_value;
                }
            }

            return expected;
        }

        let env;
        before(async () => {
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false, true);

            await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(PERSON_ATTRIBUTES), test_utils.deepClone(test_data));
        });

        after(async () => {
            env.close();
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        /** HASH ATTRIBUTE **/

        it("test between 11 & 100 on hash column limit 20", () => {
            let expected = {"11":{"id":11},"12":{"id":12},"13":{"id":13},"14":{"id":14},"15":{"id":15},"16":{"id":16},"17":{"id":17},"18":{"id":18},"19":{"id":19},"20":{"id":20},"21":{"id":21},"22":{"id":22},"23":{"id":23},"24":{"id":24},"25":{"id":25},"26":{"id":26},"27":{"id":27},"28":{"id":28},"29":{"id":29},"30":{"id":30}};
            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'id', '11', 100, 20], undefined);

            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test between 11 & 100 on hash column limit 20 offset 20", () => {
            let expected = {"31":{"id":31},"32":{"id":32},"33":{"id":33},"34":{"id":34},"35":{"id":35},"36":{"id":36},"37":{"id":37},"38":{"id":38},"39":{"id":39},"40":{"id":40},"41":{"id":41},"42":{"id":42},"43":{"id":43},"44":{"id":44},"45":{"id":45},"46":{"id":46},"47":{"id":47},"48":{"id":48},"49":{"id":49},"50":{"id":50}};
            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'id', '11', 100, 20, 20], undefined);

            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test between 0 and 111 on age limit 20", () => {
            let expected = {"54":{"age":1,"id":54},"97":{"age":0,"id":97},"196":{"age":2,"id":196},"222":{"age":1,"id":222},"259":{"age":2,"id":259},"265":{"age":0,"id":265},"268":{"age":1,"id":268},"299":{"age":0,"id":299},"356":{"age":0,"id":356},"389":{"age":0,"id":389},"422":{"age":1,"id":422},"490":{"age":1,"id":490},"506":{"age":1,"id":506},"535":{"age":1,"id":535},"547":{"age":1,"id":547},"567":{"age":0,"id":567},"591":{"age":1,"id":591},"668":{"age":1,"id":668},"710":{"age":0,"id":710},"767":{"age":1,"id":767}};

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'age', '0', '111', 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test between 0 and 111 on age limit 20 offset 20", () => {
            let expected = {"63":{"age":4,"id":63},"125":{"age":3,"id":125},"163":{"age":4,"id":163},"348":{"age":4,"id":348},"384":{"age":2,"id":384},"387":{"age":3,"id":387},"400":{"age":4,"id":400},"410":{"age":4,"id":410},"509":{"age":3,"id":509},"515":{"age":4,"id":515},"603":{"age":2,"id":603},"619":{"age":3,"id":619},"757":{"age":2,"id":757},"780":{"age":3,"id":780},"840":{"age":2,"id":840},"858":{"age":3,"id":858},"861":{"age":2,"id":861},"900":{"age":2,"id":900},"924":{"age":3,"id":924},"930":{"age":2,"id":930}};

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'age', '0', '111', 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        /** STRING **/

        it("test between CO and WY on string key column limit 20", () => {
            let expected = {"0":{"state":"CT","id":0},"58":{"state":"CO","id":58},"60":{"state":"CO","id":60},"83":{"state":"CO","id":83},"88":{"state":"CO","id":88},"172":{"state":"CO","id":172},"224":{"state":"CO","id":224},"229":{"state":"CO","id":229},"330":{"state":"CO","id":330},"384":{"state":"CO","id":384},"418":{"state":"CO","id":418},"481":{"state":"CO","id":481},"521":{"state":"CO","id":521},"611":{"state":"CO","id":611},"644":{"state":"CO","id":644},"658":{"state":"CO","id":658},"701":{"state":"CO","id":701},"943":{"state":"CO","id":943},"946":{"state":"CO","id":946},"967":{"state":"CO","id":967}};

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'state', 'CO', 'WY', 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test between CO and WY on string key column limit 20 offset 20", () => {
            let expected = {"12":{"state":"CT","id":12},"34":{"state":"CT","id":34},"69":{"state":"CT","id":69},"70":{"state":"CT","id":70},"142":{"state":"CT","id":142},"143":{"state":"CT","id":143},"153":{"state":"CT","id":153},"263":{"state":"CT","id":263},"309":{"state":"CT","id":309},"360":{"state":"CT","id":360},"383":{"state":"CT","id":383},"411":{"state":"CT","id":411},"423":{"state":"CT","id":423},"444":{"state":"CT","id":444},"497":{"state":"CT","id":497},"593":{"state":"CT","id":593},"671":{"state":"CT","id":671},"717":{"state":"CT","id":717},"896":{"state":"CT","id":896},"908":{"state":"CT","id":908}};

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'state', 'CO', 'WY', 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test between C and W on string key column limit 20", () => {
            let expected = {"44":{"state":"CA","id":44},"126":{"state":"CA","id":126},"219":{"state":"CA","id":219},"239":{"state":"CA","id":239},"254":{"state":"CA","id":254},"262":{"state":"CA","id":262},"358":{"state":"CA","id":358},"421":{"state":"CA","id":421},"455":{"state":"CA","id":455},"484":{"state":"CA","id":484},"504":{"state":"CA","id":504},"604":{"state":"CA","id":604},"607":{"state":"CA","id":607},"668":{"state":"CA","id":668},"726":{"state":"CA","id":726},"744":{"state":"CA","id":744},"904":{"state":"CA","id":904},"944":{"state":"CA","id":944},"951":{"state":"CA","id":951},"973":{"state":"CA","id":973}};

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'state', 'C', 'W', 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it("test between C and W on string key column limit 20 offset 20", () => {
            let expected = {"58":{"state":"CO","id":58},"60":{"state":"CO","id":60},"83":{"state":"CO","id":83},"88":{"state":"CO","id":88},"172":{"state":"CO","id":172},"224":{"state":"CO","id":224},"229":{"state":"CO","id":229},"330":{"state":"CO","id":330},"384":{"state":"CO","id":384},"418":{"state":"CO","id":418},"481":{"state":"CO","id":481},"521":{"state":"CO","id":521},"611":{"state":"CO","id":611},"644":{"state":"CO","id":644},"658":{"state":"CO","id":658},"701":{"state":"CO","id":701},"943":{"state":"CO","id":943},"946":{"state":"CO","id":946},"967":{"state":"CO","id":967},"996":{"state":"CA","id":996}};

            let results = test_utils.assertErrorSync(search_util.between, [env, 'id', 'state', 'C', 'W', 20, 20], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });
    });

});