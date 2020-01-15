"use strict";

const write_utility = require('../../../utility/lmdb/writeUtility');
const environment_utility = require('../../../utility/lmdb/environmentUtility');
const rewire = require('rewire');
const rw_write_util = rewire('../../../utility/lmdb/writeUtility');
const rw_insert_validator = rw_write_util.__get__('validateInsert');
const rw_stringify_data = rw_write_util.__get__('stringifyData');

const assert = require('assert');
const path = require('path');
const test_utils = require('../../test_utils');
const fs = require('fs-extra');

const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'lmdbTest');
const TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';
const ALL_ATTRIBUTES = ['id', 'name', 'age'];
const ONE_RECORD_ARRAY = [
    {id:1, name:'Kyle', age:'46'}
];

const ENV_REQUIRED_ERROR = new Error('env is required');
const INVALID_ENV_ERROR = new Error('invalid environment object');
const HASH_ATTRIBUTE_REQUIRED_ERROR = new Error('hash_attribute is required');
const ALL_ATTRIBUTES_REQUIRED_ERROR = new Error('all_attributes is required');
const ALL_ATTRIBUTES_AS_ARRAY_ERROR = new Error('all_attributes must be an array');
const RECORDS_REQUIRED_ERROR = new Error('records is required');
const RECORDS_IS_ARRAY_ERROR = new Error('records must be an array');

describe("Test writeUtility module", ()=>{
    describe("Test validateInsert function", ()=>{
        let env;
        before(async ()=>{
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        });

        after(async ()=>{
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("pass no args", ()=>{
            let err;
            try {
                rw_insert_validator();
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, ENV_REQUIRED_ERROR);
        });

        it("pass invalid env", ()=>{
            let err;
            try {
                rw_insert_validator('test');
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, INVALID_ENV_ERROR);
        });

        it("pass valid env, no other args", ()=>{
            let err;
            try {
                rw_insert_validator(env);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, HASH_ATTRIBUTE_REQUIRED_ERROR);
        });

        it("pass valid env hash_attribute", ()=>{
            let err;
            try {
                rw_insert_validator(env, HASH_ATTRIBUTE_NAME);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, ALL_ATTRIBUTES_REQUIRED_ERROR);
        });

        it("pass valid env hash_attribute, invalid all_attributes", ()=>{
            let err;
            try {
                rw_insert_validator(env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, ALL_ATTRIBUTES_AS_ARRAY_ERROR);
        });

        it("pass valid env hash_attribute all_attributes", ()=>{
            let err;
            try {
                rw_insert_validator(env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, RECORDS_REQUIRED_ERROR);
        });

        it("pass valid env hash_attribute all_attributes, invalid records", ()=>{
            let err;
            try {
                rw_insert_validator(env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY[0]);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, RECORDS_IS_ARRAY_ERROR);
        });

        it("pass valid env hash_attribute all_attributes records", ()=>{
            let err;
            try {
                rw_insert_validator(env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);
        });
    });

    describe("Test stringifyData function", ()=>{
        before(async ()=>{
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("pass variables resolving to null", ()=>{
            let err;
            let response;
            let response1;
            let response2;
            let response3;
            try {
                response = rw_stringify_data();
                response1 = rw_stringify_data(undefined);
                response2 = rw_stringify_data(null);
                response3 = rw_stringify_data('');
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);
            assert.deepStrictEqual(response, null);
            assert.deepStrictEqual(response1, null);
            assert.deepStrictEqual(response2, null);
            assert.deepStrictEqual(response3, null);
        });

        it("pass booleans", ()=>{
            let err;
            let response;
            let response1;
            try {
                response = rw_stringify_data(true);
                response1 = rw_stringify_data(false);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);
            assert.deepStrictEqual(response, 'true');
            assert.deepStrictEqual(response1, 'false');
        });

        it("pass arrays and object", ()=>{
            const string_array = ['a', 'bb', 'zz', 'aa111'];
            const numeric_array = [1, 100, 8.43, 7965, 22.6789];
            const mixed_type_array = [300, false, 'test', 55.532, 'stuff'];

            let err;
            let response;
            let response1;
            let response2;
            let response3;
            let response4;
            try {
                response = rw_stringify_data(string_array);
                response1 = rw_stringify_data(numeric_array);
                response2 = rw_stringify_data(mixed_type_array);
                response3 = rw_stringify_data(ONE_RECORD_ARRAY);
                response4 = rw_stringify_data(ONE_RECORD_ARRAY[0]);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);
            assert.deepStrictEqual(response, JSON.stringify(string_array));
            assert.deepStrictEqual(response1, JSON.stringify(numeric_array));
            assert.deepStrictEqual(response2, JSON.stringify(mixed_type_array));
            assert.deepStrictEqual(response3, JSON.stringify(ONE_RECORD_ARRAY));
            assert.deepStrictEqual(response4, JSON.stringify(ONE_RECORD_ARRAY[0]));
        });

        it("test 511 character limit", ()=>{
            const string_511 = 'Fam 3 wolf moon hammocks pinterest, man braid austin hoodie you probably haven\'t heard of them schlitz polaroid XOXO butcher. Flexitarian leggings cold-pressed live-edge jean shorts plaid, pickled vegan raclette 8-bit literally. Chambray you probably haven\'t heard of them listicle locavore ethical lomo taxidermy viral actually. Try-hard kickstarter adaptogen, seitan sustainable yuccie tilde williamsburg meh hammock raclette single-origin coffee. Butcher celiac cold-pressed tumblr. Subway tile 3 wolf moons.';
            const string_512 = string_511 + 'i';
            let err;
            let response;
            let response1;
            try {
                response = rw_stringify_data(string_511);
                response1 = rw_stringify_data(string_512);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);
            assert.deepStrictEqual(Buffer.byteLength(string_511), 511);
            assert.deepStrictEqual(Buffer.byteLength(string_512), 512);
            assert.deepStrictEqual(response, string_511);
            assert.deepStrictEqual(response1, null);
        });
    });

    describe("Test initializeDBIs function", ()=>{
        let env;
        let rw_init_dbis;
        before(async ()=>{
            rw_init_dbis = rw_write_util.__get__('initializeDBIs');
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
        });

        after(async ()=>{
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("pass valid env hash_attribute all_attributes", ()=>{
            let err;
            try {
                rw_init_dbis(env, HASH_ATTRIBUTE_NAME, [HASH_ATTRIBUTE_NAME]);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);
        });

        it('test with new attributes', ()=>{
            let list_e;
            let dbis;
            try{
                dbis = environment_utility.listDBIs(env);
            }catch (e) {
                list_e = e;
            }
            assert.deepStrictEqual(list_e, undefined);
            assert.deepStrictEqual(dbis, [HASH_ATTRIBUTE_NAME]);

            let err;
            try{
                rw_init_dbis(env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES);
            }catch (e) {
                err = e;
            }

            assert.deepStrictEqual(err, undefined);

            let list_err;
            try{
                dbis = environment_utility.listDBIs(env);
            }catch (e) {
                list_err = e;
            }

            assert.deepStrictEqual(list_err, undefined);
            assert.deepStrictEqual(dbis, [
                "age",
                "id",
                "name"
            ]);
        });
    });

    describe("Test insertRecords function", ()=>{
        let env;
        before(async ()=>{
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
        });

        after(async ()=>{
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("pass no args", ()=>{
            let err;
            try {
                write_utility.insertRecords();
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, ENV_REQUIRED_ERROR);
        });

        it("pass invalid env", ()=>{
            let err;
            try {
                write_utility.insertRecords('test');
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, INVALID_ENV_ERROR);
        });

        it("pass valid env, no other args", ()=>{
            let err;
            try {
                write_utility.insertRecords(env);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, HASH_ATTRIBUTE_REQUIRED_ERROR);
        });

        it("pass valid env hash_attribute", ()=>{
            let err;
            try {
                write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, ALL_ATTRIBUTES_REQUIRED_ERROR);
        });

        it("pass valid env hash_attribute, invalid all_attributes", ()=>{
            let err;
            try {
                write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, ALL_ATTRIBUTES_AS_ARRAY_ERROR);
        });

        it("pass valid env hash_attribute all_attributes", ()=>{
            let err;
            try {
                write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, RECORDS_REQUIRED_ERROR);
        });

        it("pass valid env hash_attribute all_attributes, invalid records", ()=>{
            let err;
            try {
                write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY[0]);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, RECORDS_IS_ARRAY_ERROR);
        });

        it("pass valid env hash_attribute all_attributes records", ()=>{
            let err;
            try {
                write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, ONE_RECORD_ARRAY);
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);
        });
    });
});