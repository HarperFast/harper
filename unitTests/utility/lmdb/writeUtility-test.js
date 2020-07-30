"use strict";

const rewire = require('rewire');
const common = require('../../../utility/lmdb/commonUtility');
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
const alasql = require('alasql');
const hdb_terms = require('../../../utility/hdbTerms');
const InsertRecordsResponseObject = require('../../../utility/lmdb/InsertRecordsResponseObject');
const UpdateRecordsResponseObject = require('../../../utility/lmdb/UpdateRecordsResponseObject');

const TIMESTAMP = Date.now();

const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'lmdbTest');
const TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';
const ALL_ATTRIBUTES = ['id', 'name', 'age', '__createdtime__', '__updatedtime__', '__blob__'];
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

const TXN_TIMESTAMP = common.getMicroTime();

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
            let record = test_utils.deepClone(ONE_RECORD_ARRAY[0]);
            test_utils.assertErrorSync(rw_write_validator, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, record], LMDB_TEST_ERRORS.RECORDS_MUST_BE_ARRAY,
                "pass valid env hash_attribute all_attributes, invalid records");
            test_utils.assertErrorSync(rw_write_validator, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, []], undefined,
                "pass valid env hash_attribute all_attributes records");
        });
    });

    describe("Test insertRecords function", ()=>{
        let stub;
        let get_micro_time_stub;
        before(()=>{
            date_stub.restore();
            get_micro_time_stub = sandbox.stub(common, 'getMicroTime').returns(TXN_TIMESTAMP);
        });

        after(()=>{
            get_micro_time_stub.restore();
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
            let record = test_utils.deepClone(ONE_RECORD_ARRAY[0]);
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, record], LMDB_TEST_ERRORS.RECORDS_MUST_BE_ARRAY,
                "pass valid env hash_attribute all_attributes, invalid records");
            test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, []], undefined,
                "pass valid env hash_attribute all_attributes records");
        });

        it("test insert one row", ()=>{
            //test no records
            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            assert.deepStrictEqual(records, []);
            let insert_records = test_utils.deepClone(ONE_RECORD_ARRAY);
            let result = test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, insert_records], undefined,
                "pass valid env hash_attribute all_attributes records");

            let expected_result = new InsertRecordsResponseObject([1], [], TXN_TIMESTAMP);
            assert.deepStrictEqual(result, expected_result);

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            let expected = [ONE_RECORD_ARRAY_EXPECTED[0]];
            assert.deepEqual(records, expected);
        });

        it("test insert one row that already exists", ()=>{
            let insert_records = test_utils.deepClone(ONE_RECORD_ARRAY);
            let result = test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, insert_records], undefined,
                "pass valid env hash_attribute all_attributes records");

            let expected_result = new InsertRecordsResponseObject([1], [], TXN_TIMESTAMP);
            assert.deepStrictEqual(result, expected_result);

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            let expected = [ONE_RECORD_ARRAY_EXPECTED[0]];
            assert.deepEqual(records, expected);

            result = test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, insert_records], undefined,
                "pass valid env hash_attribute all_attributes records");

            expected_result = new InsertRecordsResponseObject([], [1], TXN_TIMESTAMP);
            assert.deepStrictEqual(result, expected_result);
            assert.deepStrictEqual(insert_records, []);
        });

        it("test long text is written to blob dbi", ()=>{
            let record = {
                id: 10000,
                text: 'Occupy messenger bag microdosing yr, kale chips neutra la croix VHS ugh wayfarers street art. Ethical cronut whatever, cold-pressed viral post-ironic man bun swag marfa green juice. Knausgaard gluten-free selvage ethical subway tile sartorial man bun butcher selfies raclette paleo. Fam brunch plaid woke authentic dreamcatcher hot chicken quinoa gochujang slow-carb selfies keytar PBR&B street art pinterest. Narwhal tote bag glossier paleo cronut salvia cloud bread craft beer butcher meditation fingerstache hella migas 8-bit messenger bag. Tattooed schlitz palo santo gluten-free, wayfarers tumeric squid. Hella keytar thundercats chambray, occupy iPhone paleo slow-carb jianbing everyday carry 90\'s distillery polaroid fanny pack. Kombucha cray PBR&B shoreditch 8-bit, adaptogen vinyl swag meditation 3 wolf moon. Selvage art party retro kitsch pour-over iPhone street art celiac etsy cred cliche gastropub. Kombucha migas marfa listicle cliche. Godard kombucha ennui lumbersexual, austin pop-up raclette retro. Man braid kale chips pitchfork, tote bag hoodie poke mumblecore. Bitters shoreditch tbh everyday carry keffiyeh raw denim kale chips.'
            };

            let result = test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ['id', 'text'], [record]], undefined);
            let expected_result = new InsertRecordsResponseObject([record.id], [], TXN_TIMESTAMP);
            assert.deepStrictEqual(result, expected_result);

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, Object.keys(record)], undefined);
            let expected = [record];
            assert.deepEqual(records, expected);

            let txn = new environment_utility.TransactionCursor(env, '__blob__');
            let key = txn.cursor.goToKey(`text/${record.id}`);
            assert.deepStrictEqual(key, `text/${record.id}`);
            let value = txn.cursor.getCurrentString();
            assert.deepStrictEqual(value, record.text);
            txn.close();
        });

        it("test insert with alasql function", ()=>{
            let now_func = alasql.compile(`SELECT NOW() AS [${hdb_terms.FUNC_VAL}] FROM ?`);
            let rando_func = alasql.compile(`SELECT RANDOM() AS [${hdb_terms.FUNC_VAL}] FROM ?`);

            let record = {
                id:2000,
                timestamp: now_func,
                rando: rando_func
            };

            let result = test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ['id', 'timestamp', 'rando'], [record]], undefined);
            let expected_result = new InsertRecordsResponseObject([record.id], [], TXN_TIMESTAMP);
            assert.deepStrictEqual(result, expected_result);

            let results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'timestamp'], undefined, 'timestamp iterate');
            let time_stamp_dbi = {[record.timestamp]: [record.id.toString()]};
            assert.deepStrictEqual(results, test_utils.assignObjecttoNullObject(time_stamp_dbi));

            results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'rando'], undefined, 'rando iterate');
            let rando_dbi = {[record.rando]: [record.id.toString()]};
            assert.deepStrictEqual(results, test_utils.assignObjecttoNullObject( rando_dbi));

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, Object.keys(record)], undefined);
            let expected = [record];
            assert.deepEqual(records, expected);
        });
    });

    describe("Test updateRecords function", ()=>{
        let env;
        let get_micro_time_stub;
        before(()=>{
            date_stub.restore();
            get_micro_time_stub = sandbox.stub(common, 'getMicroTime').returns(TXN_TIMESTAMP);
        });

        after(()=>{
            date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
            get_micro_time_stub.restore();
        });

        beforeEach(async ()=>{
            date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id', false);
            await environment_utility.createDBI(env, '__blob__', false);
            let insert_records = test_utils.deepClone(ONE_RECORD_ARRAY);
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(ALL_ATTRIBUTES), insert_records);
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
            let insert_record = test_utils.deepClone(ONE_RECORD_ARRAY[0]);
            test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, insert_record], LMDB_TEST_ERRORS.RECORDS_MUST_BE_ARRAY,
                "pass valid env hash_attribute all_attributes, invalid records");
            test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, []], undefined,
                "pass valid env hash_attribute all_attributes records");
        });

        it("test update one existing row", ()=>{
            let all_attributes_for_update = ['__blob__', '__createdtime__', '__updatedtime__','age', 'height', 'id', 'name'];

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            let expected = [test_utils.assignObjecttoNullObject(ONE_RECORD_ARRAY_EXPECTED[0])];
            assert.deepStrictEqual(records, expected);

            let orig_records = [];
            records.forEach(rec=>{
                let record = test_utils.assignObjecttoNullObject(rec);
                record.height = null;
                delete  record.__blob__;
                orig_records.push(record);
            });
            let expected_update_response = new UpdateRecordsResponseObject([1], [], TXN_TIMESTAMP, orig_records);

            let update_records = test_utils.deepClone(UPDATE_ONE_RECORD_ARRAY);
            update_records[0]['__createdtime__'] = 'bad value';
            let results = test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, update_records], undefined);
            assert.deepStrictEqual(results, expected_update_response);

            let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
            assert.deepStrictEqual(all_dbis, all_attributes_for_update);

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, all_dbis], undefined);
            let expected2 = [test_utils.assignObjecttoNullObject(UPDATE_ONE_RECORD_ARRAY_EXPECTED[0])];
            assert.deepStrictEqual(records,expected2);
        });

        it("test update one existing row & one non-existing row", ()=>{
            let all_attributes_for_update = ['__blob__','__createdtime__', '__updatedtime__','age', 'height', 'id', 'name'];

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            let expected = [test_utils.assignObjecttoNullObject(ONE_RECORD_ARRAY_EXPECTED[0])];
            assert.deepStrictEqual(records, expected);
            let update_records = test_utils.deepClone(UPDATE_ONE_RECORD_ARRAY.concat(UPDATE_ONE_FAKE_RECORD));
            let results = test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, update_records], undefined);

            let orig_records = [];
            records.forEach(rec=>{
                let record = test_utils.assignObjecttoNullObject(rec);
                record.height = null;
                delete  record.__blob__;
                orig_records.push(record);
            });
            let expected_update_response = new UpdateRecordsResponseObject([1], [111], TXN_TIMESTAMP, orig_records);

            let expected_update_records = test_utils.deepClone(UPDATE_ONE_RECORD_ARRAY);
            expected_update_records[0].__updatedtime__ = TIMESTAMP;
            assert.deepStrictEqual(update_records, expected_update_records);
            assert.deepStrictEqual(results, expected_update_response);

            let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
            assert.deepStrictEqual(all_dbis, all_attributes_for_update);

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, all_dbis], undefined);
            let expected2 = [ test_utils.assignObjecttoNullObject(UPDATE_ONE_RECORD_ARRAY_EXPECTED[0])];
            assert.deepStrictEqual(records,expected2);
        });

        it("test partially updating row & make sure other attributes are untouched", ()=>{
            let all_attributes_for_update = ['__blob__','__createdtime__', '__updatedtime__','age', 'height', 'id', 'name', 'city'];

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            let expected = [ test_utils.assignObjecttoNullObject(ONE_RECORD_ARRAY_EXPECTED[0])];
            assert.deepStrictEqual(records, expected);

            let orig_records = [];
            records.forEach(rec=>{
                let record = test_utils.assignObjecttoNullObject(rec);
                record.height = record.city = null;
                delete  record.__blob__;
                orig_records.push(record);
            });
            let expected_update_response = new UpdateRecordsResponseObject([1], [], TXN_TIMESTAMP, orig_records);

            let results = test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, [{id:1, city:'Denver'}]], undefined);
            assert.deepStrictEqual(results, expected_update_response);

            /*let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
            assert.deepStrictEqual(all_dbis, all_attributes_for_update);*/

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ['id', 'name', 'city', 'age']], undefined);
            let expected2 = [test_utils.assignObjecttoNullObject({id:1, name: 'Kyle', city:'Denver', age: 46})];
            assert.deepStrictEqual(records,expected2);
        });

        it("test partially updating row to have long text, then change the long text", ()=>{
            let all_attributes_for_update = ['__blob__', '__createdtime__', '__updatedtime__','age', 'height', 'id', 'name', 'city', 'text'];
            let record = {
                id: 1,
                text: 'Occupy messenger bag microdosing yr, kale chips neutra la croix VHS ugh wayfarers street art. Ethical cronut whatever, cold-pressed viral post-ironic man bun swag marfa green juice. Knausgaard gluten-free selvage ethical subway tile sartorial man bun butcher selfies raclette paleo. Fam brunch plaid woke authentic dreamcatcher hot chicken quinoa gochujang slow-carb selfies keytar PBR&B street art pinterest. Narwhal tote bag glossier paleo cronut salvia cloud bread craft beer butcher meditation fingerstache hella migas 8-bit messenger bag. Tattooed schlitz palo santo gluten-free, wayfarers tumeric squid. Hella keytar thundercats chambray, occupy iPhone paleo slow-carb jianbing everyday carry 90\'s distillery polaroid fanny pack. Kombucha cray PBR&B shoreditch 8-bit, adaptogen vinyl swag meditation 3 wolf moon. Selvage art party retro kitsch pour-over iPhone street art celiac etsy cred cliche gastropub. Kombucha migas marfa listicle cliche. Godard kombucha ennui lumbersexual, austin pop-up raclette retro. Man braid kale chips pitchfork, tote bag hoodie poke mumblecore. Bitters shoreditch tbh everyday carry keffiyeh raw denim kale chips.'
            };

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            let expected = [test_utils.assignObjecttoNullObject(ONE_RECORD_ARRAY_EXPECTED[0])];
            assert.deepStrictEqual(records, expected);

            let orig_records = [];
            records.forEach(rec=>{
                let record = test_utils.assignObjecttoNullObject(rec);
                record.height = record.city = record.text = null;
                delete  record.__blob__;
                orig_records.push(record);
            });
            let expected_update_response = new UpdateRecordsResponseObject([1], [], TXN_TIMESTAMP, orig_records);

            let results = test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, [record]], undefined);
            assert.deepStrictEqual(results, expected_update_response);

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update], undefined);
            let expected2 = [test_utils.assignObjecttoNullObject({id:1, name: 'Kyle', city:null, age: 46, text:record.text, __updatedtime__: TIMESTAMP, __createdtime__: TIMESTAMP, __blob__:null, height:null})];
            assert.deepStrictEqual(records,expected2);

            let txn = new environment_utility.TransactionCursor(env, '__blob__');
            let key = txn.cursor.goToKey(`text/${record.id}`);
            assert.deepStrictEqual(key, `text/${record.id}`);
            let value = txn.cursor.getCurrentString();
            assert.deepStrictEqual(value, record.text);
            txn.close();

            //set text to undefined & verify it's gone

            orig_records = [];
            records.forEach(rec=>{
                let record = test_utils.assignObjecttoNullObject(rec);
                delete  record.__blob__;
                orig_records.push(record);
            });
            expected_update_response = new UpdateRecordsResponseObject([1], [], TXN_TIMESTAMP, orig_records);

            results = test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, [{id:1, text:undefined}]], undefined);
            assert.deepStrictEqual(results, expected_update_response);

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ['id', 'name', 'city', 'age', 'text']], undefined);
            expected2 = [test_utils.assignObjecttoNullObject({id:1, name: 'Kyle', city:null, age: 46, text:null})];
            assert.deepStrictEqual(records,expected2);
            txn = new environment_utility.TransactionCursor(env, '__blob__');
            key = txn.cursor.goToKey(`text/${record.id}`);
            assert.deepStrictEqual(key, null);
            txn.close();
        });

        it("test partially updating row to have long text which is json, then remove the json", ()=>{
            let all_attributes_for_update = ['__blob__', '__createdtime__', '__updatedtime__','age', 'height', 'id', 'name', 'city', 'json'];
            let record = {
                id: 1,
                json: {text: 'Occupy messenger bag microdosing yr, kale chips neutra la croix VHS ugh wayfarers street art. Ethical cronut whatever, cold-pressed viral post-ironic man bun swag marfa green juice. Knausgaard gluten-free selvage ethical subway tile sartorial man bun butcher selfies raclette paleo. Fam brunch plaid woke authentic dreamcatcher hot chicken quinoa gochujang slow-carb selfies keytar PBR&B street art pinterest. Narwhal tote bag glossier paleo cronut salvia cloud bread craft beer butcher meditation fingerstache hella migas 8-bit messenger bag. Tattooed schlitz palo santo gluten-free, wayfarers tumeric squid. Hella keytar thundercats chambray, occupy iPhone paleo slow-carb jianbing everyday carry 90\'s distillery polaroid fanny pack. Kombucha cray PBR&B shoreditch 8-bit, adaptogen vinyl swag meditation 3 wolf moon. Selvage art party retro kitsch pour-over iPhone street art celiac etsy cred cliche gastropub. Kombucha migas marfa listicle cliche. Godard kombucha ennui lumbersexual, austin pop-up raclette retro. Man braid kale chips pitchfork, tote bag hoodie poke mumblecore. Bitters shoreditch tbh everyday carry keffiyeh raw denim kale chips.'}
            };

            let records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES], undefined);
            let expected = [test_utils.assignObjecttoNullObject(ONE_RECORD_ARRAY_EXPECTED[0])];
            assert.deepEqual(records, expected);

            let orig_records = [];
            records.forEach(rec=>{
                let record = test_utils.assignObjecttoNullObject(rec);
                record.height = record.city = record.json = null;
                delete  record.__blob__;
                orig_records.push(record);
            });
            let expected_update_response = new UpdateRecordsResponseObject([1], [], TXN_TIMESTAMP, orig_records);

            let results = test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, [record]], undefined);
            assert.deepStrictEqual(results, expected_update_response);

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update], undefined);
            let expected2 = [test_utils.assignObjecttoNullObject({id:1, name: 'Kyle', city:null, age: 46, height: null, json:record.json, __blob__:null, __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP})];
            assert.deepStrictEqual(records,expected2);

            let txn = new environment_utility.TransactionCursor(env, '__blob__');
            let key = txn.cursor.goToKey(`json/${record.id}`);
            assert.deepStrictEqual(key, `json/${record.id}`);
            let value = txn.cursor.getCurrentString();
            assert.deepStrictEqual(value, JSON.stringify(record.json));
            txn.close();

            //set json to undefined & verify it's gone

            orig_records = [];
            orig_records.push(test_utils.assignObjecttoNullObject(records[0]));
            delete orig_records[0].__blob__;
            expected_update_response = new UpdateRecordsResponseObject([1], [], TXN_TIMESTAMP, orig_records);

            results = test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, [{id:1, json:undefined}]], undefined);
            assert.deepStrictEqual(results, expected_update_response);

            records = test_utils.assertErrorSync(search_util.searchAll, [env, HASH_ATTRIBUTE_NAME, ['id', 'name', 'city', 'age', 'json']], undefined);
            expected2 = [test_utils.assignObjecttoNullObject({id:1, name: 'Kyle', city:null, age: 46, json:null})];
            assert.deepStrictEqual(records,expected2);
            txn = new environment_utility.TransactionCursor(env, '__blob__');
            key = txn.cursor.goToKey(`json/${record.id}`);
            assert.deepStrictEqual(key, null);
            txn.close();
        });

        it("test update with alasql function", ()=>{
            let now_func = alasql.compile(`SELECT NOW() AS [${hdb_terms.FUNC_VAL}] FROM ?`);
            let rando_func = alasql.compile(`SELECT RANDOM() AS [${hdb_terms.FUNC_VAL}] FROM ?`);

            let record = test_utils.assignObjecttoNullObject({
                id:2000,
                timestamp: now_func,
                rando: rando_func
            });

            let result = test_utils.assertErrorSync(write_utility.insertRecords, [env, HASH_ATTRIBUTE_NAME, ['id', 'timestamp', 'rando'], [record]], undefined);

            assert.deepStrictEqual(result, new InsertRecordsResponseObject([record.id], [], TXN_TIMESTAMP));

            let results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'timestamp'], undefined, 'timestamp iterate');
            let time_stamp_dbi = {[record.timestamp]: [record.id.toString()]};
            assert.deepStrictEqual(results, Object.assign(Object.create(null), time_stamp_dbi));

            results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'rando'], undefined, 'rando iterate');
            let rando_dbi = {[record.rando]: [record.id.toString()]};
            assert.deepStrictEqual(results, Object.assign(Object.create(null), rando_dbi));

            let records = test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, Object.keys(record), record.id.toString()], undefined);
            assert.deepStrictEqual(records, record);

            let orig_records = [test_utils.assignObjecttoNullObject(records)];
            orig_records[0].age = null;
            orig_records[0].name = null;
            delete orig_records[0].__blob__;
            let expected_update_response = new UpdateRecordsResponseObject([record.id], [], TXN_TIMESTAMP, orig_records);

            rando_func = alasql.compile(`SELECT rando + 1 AS [${hdb_terms.FUNC_VAL}] FROM ?`);

            record.rando = rando_func;
            result = test_utils.assertErrorSync(write_utility.updateRecords, [env, HASH_ATTRIBUTE_NAME, ['id', 'timestamp', 'rando'], [record]], undefined);
            assert.deepStrictEqual(result, expected_update_response);

            results = test_utils.assertErrorSync(search_util.iterateDBI, [env, 'rando'], undefined, 'rando iterate');
            rando_dbi = {[record.rando]: [record.id.toString()]};
            assert.deepStrictEqual(results, test_utils.assignObjecttoNullObject(rando_dbi));

            records = test_utils.assertErrorSync(search_util.searchByHash, [env, HASH_ATTRIBUTE_NAME, Object.keys(record), record.id.toString()], undefined);
            assert.deepStrictEqual(records, record);
        });

    });
});