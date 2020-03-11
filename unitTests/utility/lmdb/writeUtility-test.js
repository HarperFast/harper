"use strict";

const rewire = require('rewire');
const write_utility = rewire('../../../utility/lmdb/writeUtility');
const environment_utility = rewire('../../../utility/lmdb/environmentUtility');
const rw_write_validator = write_utility.__get__('validateWrite');
const search_util = require('../../../utility/lmdb/searchUtility');
const assert = require('assert');
const path = require('path');
const test_utils = require('../../test_utils');
const fs = require('fs-extra');
const LMDB_TEST_ERRORS = require('../../commonTestErrors').LMDB_ERRORS_ENUM;
const sinon = require('sinon');

const TIMESTAMP = Date.now();

const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'lmdbTest');
const TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';
const ALL_ATTRIBUTES = ['id', 'name', 'age', '__createdtime__', '__updatedtime__'];
const ONE_RECORD_ARRAY = [
    {id:1, name:'Kyle', age:'46'}
];

const ONE_RECORD_ARRAY_EXPECTED = [
    {__blob__: null,__createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP,id:1, name:'Kyle', age:46}
];

const UPDATE_ONE_RECORD_ARRAY = [
    {id:1, name:'Kyle Bernhardy', age:'46', height:'6\'1"'}
];

const UPDATE_ONE_RECORD_ARRAY_EXPECTED = [
    {__blob__: null, __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP, id:1, name:'Kyle Bernhardy', age:46, height:'6\'1"'}
];

const sandbox = sinon.createSandbox();

const UPDATE_ONE_FAKE_RECORD = {id:111, name:'FAKE ROW', age:0};

describe("Test writeUtility module", ()=>{
    let date_stub;
    let rw_env_util;
    before(()=>{
        rw_env_util = environment_utility.__set__('MAP_SIZE', 10*1024*1024*1024);
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
    });

    after(()=>{
        rw_env_util();
        date_stub.restore();
    });

    describe("Test validateInsert function", ()=>{
        let env;
        before(async ()=>{
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        });

        after(async ()=>{
            sandbox.restore();
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test function", ()=>{
            test_utils.assertErrorSync(rw_write_validator, [], LMDB_TEST_ERRORS.ENV_REQUIRED, "pass no args");
            test_utils.assertErrorSync(rw_write_validator, ['test'], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, "pass invalid env");
            test_utils.assertErrorSync(rw_write_validator, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, "pass valid env, no other args");
            test_utils.assertErrorSync(rw_write_validator, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_REQUIRED, "pass valid env hash_attribute");
            test_utils.assertErrorSync(rw_write_validator, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY,
                "pass valid env hash_attribute, invalid all_attributes");
            test_utils.assertErrorSync(rw_write_validator, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], LMDB_TEST_ERRORS.RECORDS_REQUIRED,
                "pass valid env hash_attribute all_attributes");
            test_utils.assertErrorSync(rw_write_validator, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY[0]], LMDB_TEST_ERRORS.RECORDS_MUST_BE_ARRAY,
                "pass valid env hash_attribute all_attributes, invalid records");
            test_utils.assertErrorSync(rw_write_validator, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, []], undefined,
                "pass valid env hash_attribute all_attributes records");
        });
    });

    describe("Test insertRecords function", ()=>{
        let stub;
        before(()=>{
            date_stub.restore();

        });

        after(()=>{
            date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
        });
        let env;
        beforeEach(async ()=>{
            date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false);
            await environment_utility.createDBI(env, '__blob__', false);
        });

        afterEach(async ()=>{
            date_stub.restore();
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", ()=>{
            test_utils.assertErrorSync(write_utility.insertRecords, [], LMDB_TEST_ERRORS.ENV_REQUIRED, "pass no args");
            test_utils.assertErrorSync(write_utility.insertRecords, ['test'], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, "pass invalid env");
            test_utils.assertErrorSync(write_utility.insertRecords, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, "pass valid env, no other args");
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_REQUIRED, "pass valid env hash_attribute");
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY,
                "pass valid env hash_attribute, invalid all_attributes");
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], LMDB_TEST_ERRORS.RECORDS_REQUIRED,
                "pass valid env hash_attribute all_attributes");
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY[0]], LMDB_TEST_ERRORS.RECORDS_MUST_BE_ARRAY,
                "pass valid env hash_attribute all_attributes, invalid records");
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, []], undefined,
                "pass valid env hash_attribute all_attributes records");
        });

        it("test insert one row", ()=>{
            //test no records
            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            assert.deepStrictEqual(records, []);

            let result = test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY], undefined,
                "pass valid env hash_attribute all_attributes records");

            assert.deepStrictEqual(result, {written_hashes: [1], skipped_hashes: []});

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            let expected = [Object.assign(Object.create(null), ONE_RECORD_ARRAY_EXPECTED[0])];
            assert.deepStrictEqual(records, expected);
        });

        //TODO validate existing records being inserted are added to skipped
        it("test insert one row that already exists", ()=>{
            let result = test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY], undefined,
                "pass valid env hash_attribute all_attributes records");

            assert.deepStrictEqual(result, {written_hashes: [1], skipped_hashes: []});

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            let expected = [Object.assign(Object.create(null), ONE_RECORD_ARRAY_EXPECTED[0])];
            assert.deepStrictEqual(records, expected);

            result = test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY], undefined,
                "pass valid env hash_attribute all_attributes records");

            assert.deepStrictEqual(result, {written_hashes: [], skipped_hashes: [1]});
        });

        it("test long text is written to blob dbi", ()=>{
            let record = {
                id: 10000,
                text: 'Occupy messenger bag microdosing yr, kale chips neutra la croix VHS ugh wayfarers street art. Ethical cronut whatever, cold-pressed viral post-ironic man bun swag marfa green juice. Knausgaard gluten-free selvage ethical subway tile sartorial man bun butcher selfies raclette paleo. Fam brunch plaid woke authentic dreamcatcher hot chicken quinoa gochujang slow-carb selfies keytar PBR&B street art pinterest. Narwhal tote bag glossier paleo cronut salvia cloud bread craft beer butcher meditation fingerstache hella migas 8-bit messenger bag. Tattooed schlitz palo santo gluten-free, wayfarers tumeric squid. Hella keytar thundercats chambray, occupy iPhone paleo slow-carb jianbing everyday carry 90\'s distillery polaroid fanny pack. Kombucha cray PBR&B shoreditch 8-bit, adaptogen vinyl swag meditation 3 wolf moon. Selvage art party retro kitsch pour-over iPhone street art celiac etsy cred cliche gastropub. Kombucha migas marfa listicle cliche. Godard kombucha ennui lumbersexual, austin pop-up raclette retro. Man braid kale chips pitchfork, tote bag hoodie poke mumblecore. Bitters shoreditch tbh everyday carry keffiyeh raw denim kale chips.'
            };

            let result = test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ['id', 'text'], [record]], undefined);

            assert.deepStrictEqual(result, {written_hashes: [record.id], skipped_hashes: []});

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, Object.keys(record)], undefined);
            let expected = [Object.assign(Object.create(null), record)];
            assert.deepStrictEqual(records, [test_utils.assignObjecttoNullObject(record)]);

            let txn = new environment_utility.TransactionCursor(env, '__blob__');
            let key = txn.cursor.goToKey(`text/${record.id}`);
            assert.deepStrictEqual(key, `text/${record.id}`);
            let value = txn.cursor.getCurrentString();
            assert.deepStrictEqual(value, record.text);
            txn.close();
        });

        //TODO validate records exist in all indices
    });

    describe("Test updateRecords function", ()=>{
        let env;

        before(()=>{
            date_stub.restore();

        });

        after(()=>{
            date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
        });

        beforeEach(async ()=>{
            date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false);
            await environment_utility.createDBI(env, '__blob__', false);
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(ALL_ATTRIBUTES), ONE_RECORD_ARRAY);
        });

        afterEach(async ()=>{
            date_stub.restore();
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", ()=>{
            test_utils.assertErrorSync(write_utility.updateRecords, [], LMDB_TEST_ERRORS.ENV_REQUIRED, "pass no args");
            test_utils.assertErrorSync(write_utility.updateRecords, ['test'], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, "pass invalid env");
            test_utils.assertErrorSync(write_utility.updateRecords, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED, "pass valid env, no other args");
            test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_REQUIRED, "pass valid env hash_attribute");
            test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME], LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY,
                "pass valid env hash_attribute, invalid all_attributes");
            test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], LMDB_TEST_ERRORS.RECORDS_REQUIRED,
                "pass valid env hash_attribute all_attributes");
            test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY[0]], LMDB_TEST_ERRORS.RECORDS_MUST_BE_ARRAY,
                "pass valid env hash_attribute all_attributes, invalid records");
            test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, []], undefined,
                "pass valid env hash_attribute all_attributes records");
        });

        it("test update one existing row", ()=>{
            let all_attributes_for_update = ['__blob__', '__createdtime__', '__updatedtime__','age', 'height', 'id', 'name'];

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            let expected = [Object.assign(Object.create(null), ONE_RECORD_ARRAY_EXPECTED[0])];
            assert.deepStrictEqual(records, expected);

            let results = test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, UPDATE_ONE_RECORD_ARRAY], undefined);
            assert.deepStrictEqual(results, {written_hashes:[1], skipped_hashes:[]});

            let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
            assert.deepStrictEqual(all_dbis, all_attributes_for_update);

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, all_dbis], undefined);
            let expected2 = [Object.assign(Object.create(null), UPDATE_ONE_RECORD_ARRAY_EXPECTED[0])];
            assert.deepStrictEqual(records,expected2);
        });

        it("test update one existing row & one non-existing row", ()=>{
            let all_attributes_for_update = ['__blob__','__createdtime__', '__updatedtime__','age', 'height', 'id', 'name'];

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            let expected = [Object.assign(Object.create(null), ONE_RECORD_ARRAY_EXPECTED[0])];
            assert.deepStrictEqual(records, expected);

            let results = test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, UPDATE_ONE_RECORD_ARRAY.concat(UPDATE_ONE_FAKE_RECORD)], undefined);
            assert.deepStrictEqual(results, {written_hashes:[1], skipped_hashes:[111]});

            let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
            assert.deepStrictEqual(all_dbis, all_attributes_for_update);

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, all_dbis], undefined);
            let expected2 = [Object.assign(Object.create(null), UPDATE_ONE_RECORD_ARRAY_EXPECTED[0])];
            assert.deepStrictEqual(records,expected2);
        });

        it("test partially updating row & make sure other attributes are untouched", ()=>{
            let all_attributes_for_update = ['__blob__','__createdtime__', '__updatedtime__','age', 'height', 'id', 'name', 'city'];

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            let expected = [Object.assign(Object.create(null), ONE_RECORD_ARRAY_EXPECTED[0])];
            assert.deepStrictEqual(records, expected);

            let results = test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, [{id:1, city:'Denver'}]], undefined);
            assert.deepStrictEqual(results, {written_hashes:[1], skipped_hashes:[]});

            /*let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
            assert.deepStrictEqual(all_dbis, all_attributes_for_update);*/

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ['id', 'name', 'city', 'age']], undefined);
            let expected2 = [Object.assign(Object.create(null), {id:1, name: 'Kyle', city:'Denver', age: 46})];
            assert.deepStrictEqual(records,expected2);
        });

        it("test partially updating row to have long text, then change the long text", ()=>{
            let all_attributes_for_update = ['__blob__', '__createdtime__', '__updatedtime__','age', 'height', 'id', 'name', 'city', 'text'];
            let record = {
                id: 1,
                text: 'Occupy messenger bag microdosing yr, kale chips neutra la croix VHS ugh wayfarers street art. Ethical cronut whatever, cold-pressed viral post-ironic man bun swag marfa green juice. Knausgaard gluten-free selvage ethical subway tile sartorial man bun butcher selfies raclette paleo. Fam brunch plaid woke authentic dreamcatcher hot chicken quinoa gochujang slow-carb selfies keytar PBR&B street art pinterest. Narwhal tote bag glossier paleo cronut salvia cloud bread craft beer butcher meditation fingerstache hella migas 8-bit messenger bag. Tattooed schlitz palo santo gluten-free, wayfarers tumeric squid. Hella keytar thundercats chambray, occupy iPhone paleo slow-carb jianbing everyday carry 90\'s distillery polaroid fanny pack. Kombucha cray PBR&B shoreditch 8-bit, adaptogen vinyl swag meditation 3 wolf moon. Selvage art party retro kitsch pour-over iPhone street art celiac etsy cred cliche gastropub. Kombucha migas marfa listicle cliche. Godard kombucha ennui lumbersexual, austin pop-up raclette retro. Man braid kale chips pitchfork, tote bag hoodie poke mumblecore. Bitters shoreditch tbh everyday carry keffiyeh raw denim kale chips.'
            };

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            let expected = [Object.assign(Object.create(null), ONE_RECORD_ARRAY_EXPECTED[0])];
            assert.deepStrictEqual(records, expected);

            let results = test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, [record]], undefined);
            assert.deepStrictEqual(results, {written_hashes:[1], skipped_hashes:[]});

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ['id', 'name', 'city', 'age', 'text']], undefined);
            let expected2 = [Object.assign(Object.create(null), {id:1, name: 'Kyle', city:null, age: 46, text:record.text})];
            assert.deepStrictEqual(records,expected2);

            let txn = new environment_utility.TransactionCursor(env, '__blob__');
            let key = txn.cursor.goToKey(`text/${record.id}`);
            assert.deepStrictEqual(key, `text/${record.id}`);
            let value = txn.cursor.getCurrentString();
            assert.deepStrictEqual(value, record.text);
            txn.close();

            //set text to undefined & verify it's gone

            results = test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, [{id:1, text:undefined}]], undefined);
            assert.deepStrictEqual(results, {written_hashes:[1], skipped_hashes:[]});

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ['id', 'name', 'city', 'age', 'text']], undefined);
            expected2 = [Object.assign(Object.create(null), {id:1, name: 'Kyle', city:null, age: 46, text:null})];
            assert.deepStrictEqual(records,expected2);
            txn = new environment_utility.TransactionCursor(env, '__blob__');
            key = txn.cursor.goToKey(`text/${record.id}`);
            assert.deepStrictEqual(key, null);
            txn.close();
        });

    });
});