"use strict";

const DBIDefinition = require('../../../utility/lmdb/DBIDefinition');
const lmdb_env_util = require('../../../utility/lmdb/environmentUtility');
const rewire = require('rewire');
const rw_lmdb_env_util = rewire('../../../utility/lmdb/environmentUtility');
const assert = require('assert');
const path = require('path');
const test_utils = require('../../test_utils');
const fs = require('fs-extra');
const LMDB_TEST_ERRORS = require('../../commonTestErrors').LMDB_ERRORS_ENUM;
const lmdb_terms = require('../../../utility/lmdb/terms');

const LMDB_TEST_FOLDER_NAME = 'lmdbTest';
const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), LMDB_TEST_FOLDER_NAME);
const INVALID_BASE_TEST_PATH = '/bad/path/zzz/';
const TEST_ENVIRONMENT_NAME = 'test';
const CACHED_ENV_NAME = `${LMDB_TEST_FOLDER_NAME}.${TEST_ENVIRONMENT_NAME}`;
const BAD_TEST_ENVIRONMENT_NAME = 'bad_test';
const ID_DBI_NAME = 'id';
const ALL_ATTRIBUTES = ['id', 'name', 'age'];

const get_dbi_definition = rw_lmdb_env_util.__get__('getDBIDefinition');


describe("Test LMDB environmentUtility module", ()=>{
    let rw_env_util;
    before(async()=>{
        rw_env_util = rw_lmdb_env_util.__set__('MAP_SIZE', 5*1024*1024*1024);
        await fs.mkdirp(BASE_TEST_PATH);
        global.lmdb_map = undefined;
    });

    after(async ()=>{
        rw_env_util();
        await fs.remove(BASE_TEST_PATH);
        global.lmdb_map = undefined;
    });

    describe("Test pathEnvNameValidation function", ()=>{
        let rw_validator;
        before(()=>{
            rw_validator = rw_lmdb_env_util.__get__('pathEnvNameValidation');
        });

        it('call function no args', async ()=>{
            await test_utils.assertErrorAsync(rw_validator, [], LMDB_TEST_ERRORS.BASE_PATH_REQUIRED, 'no args');
        });

        it('call function no env_name', async()=>{
            await test_utils.assertErrorAsync(rw_validator, [BASE_TEST_PATH], LMDB_TEST_ERRORS.ENV_NAME_REQUIRED, 'no env_name');
        });

        it('call function invalid base_path', async ()=>{
            await test_utils.assertErrorAsync(rw_validator, [INVALID_BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], LMDB_TEST_ERRORS.INVALID_BASE_PATH, 'invalid base_path');
        });

        it('call function happy path', async ()=>{
            await test_utils.assertErrorAsync(rw_validator, [BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], undefined, 'happy path');
        });
    });

    describe("Test validateEnvironmentPath function", ()=>{
        let rw_validator;
        before(async ()=>{
            rw_validator = rw_lmdb_env_util.__get__('validateEnvironmentPath');
            global.lmdb_map = undefined;
            await lmdb_env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        });

        after(async ()=>{
            await fs.emptyDir(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it('call function invalid base_path', async ()=>{
            await test_utils.assertErrorAsync(rw_validator, [INVALID_BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT, 'invalid base_path');
        });

        it('call function happy path', async ()=>{
            await test_utils.assertErrorAsync(rw_validator, [BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], undefined, 'happy path');
        });
    });

    describe("Test validateEnvDBIName function", ()=>{
        let rw_validator;
        let env;
        before(async ()=>{
            rw_validator = rw_lmdb_env_util.__get__('validateEnvDBIName');
            global.lmdb_map = undefined;
            env = await lmdb_env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        });

        after(async()=>{
            await fs.emptyDir(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it('call function no args', async ()=>{
            await test_utils.assertErrorAsync(rw_validator, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'no args');
        });

        it('call function no dbi_name', async ()=>{
            await test_utils.assertErrorAsync(rw_validator, [env], LMDB_TEST_ERRORS.DBI_NAME_REQUIRED, 'no dbi_name');
        });

        it('call function happy path', async ()=>{
            await test_utils.assertErrorAsync(rw_validator, [env, ID_DBI_NAME], undefined, 'happy path');
        });
    });

    describe("Test createEnvironment function", ()=>{
        before(()=>{
            global.lmdb_map = undefined;
        });

        after(async ()=>{
            await fs.emptyDir(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it('call function no args', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.createEnvironment, [], LMDB_TEST_ERRORS.BASE_PATH_REQUIRED, 'no args');
        });

        it('call function no env_name', async()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.createEnvironment, [BASE_TEST_PATH], LMDB_TEST_ERRORS.ENV_NAME_REQUIRED, 'no env_name');
        });

        it('call function invalid base_path', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.createEnvironment, [INVALID_BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], LMDB_TEST_ERRORS.INVALID_BASE_PATH, 'invalid base_path');
        });

        it('call function happy path', async ()=>{
            let env = await test_utils.assertErrorAsync(lmdb_env_util.createEnvironment, [BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], undefined, 'happy path');

            await test_utils.assertErrorAsync(await fs.access, [path.join(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME, 'data.mdb')], undefined, 'test path exists');

            assert.notDeepStrictEqual(global.lmdb_map, undefined);
            assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME], undefined);

            //test to make sure the internal dbi exists
            await test_utils.assertErrorAsync(lmdb_env_util.openDBI, [env, lmdb_terms.INTERNAL_DBIS_NAME], undefined);

        });

        it('create existing environment', async ()=>{
            global.lmdb_map = undefined;

            let env = await test_utils.assertErrorAsync(lmdb_env_util.createEnvironment, [BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], undefined);

            await test_utils.assertErrorAsync(await fs.access, [path.join(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME, 'data.mdb')], undefined, 'test path exists');

            assert.notDeepStrictEqual(global.lmdb_map, undefined);
            assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME], undefined);

            //test to make sure the internal dbi exists
            await test_utils.assertErrorAsync(lmdb_env_util.openDBI, [env, lmdb_terms.INTERNAL_DBIS_NAME], undefined);
        });
    });

    describe("Test openEnvironment function", ()=> {
        before(async () => {
            global.lmdb_map = undefined;
            await fs.mkdirp(BASE_TEST_PATH);

            await lmdb_env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            test_utils.tearDownMockFS();
            global.lmdb_map = undefined;
        });

        it('call function no args', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.openEnvironment, [], LMDB_TEST_ERRORS.BASE_PATH_REQUIRED);
        });

        it('call function no env_name', async()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.openEnvironment, [BASE_TEST_PATH], LMDB_TEST_ERRORS.ENV_NAME_REQUIRED);
        });

        it('call function invalid base_path', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.openEnvironment, [INVALID_BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], LMDB_TEST_ERRORS.INVALID_BASE_PATH);
        });

        it('open non-existent environment', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.openEnvironment, [BASE_TEST_PATH, BAD_TEST_ENVIRONMENT_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT);
        });

        it('happy path test', async ()=>{
            let env = await test_utils.assertErrorAsync(lmdb_env_util.openEnvironment, [BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], undefined);

            assert.notDeepStrictEqual(env, undefined);
            assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME], undefined);
            assert.deepStrictEqual(env, global.lmdb_map[CACHED_ENV_NAME]);

            //test to make sure the internal dbi exists
            await test_utils.assertErrorAsync(lmdb_env_util.openDBI, [env, lmdb_terms.INTERNAL_DBIS_NAME], undefined);
        });

    });

    describe("Test deleteEnvironment function", ()=> {
        before(async () => {
            global.lmdb_map = undefined;
            await fs.mkdirp(BASE_TEST_PATH);

            await lmdb_env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            test_utils.tearDownMockFS();
            global.lmdb_map = undefined;
        });

        it('call function no args', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.deleteEnvironment, [], LMDB_TEST_ERRORS.BASE_PATH_REQUIRED);
        });

        it('call function no env_name', async()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.deleteEnvironment, [BASE_TEST_PATH], LMDB_TEST_ERRORS.ENV_NAME_REQUIRED);
        });

        it('call function invalid base_path', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.deleteEnvironment, [INVALID_BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], LMDB_TEST_ERRORS.INVALID_BASE_PATH);
        });

        it('call function invalid environment', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.deleteEnvironment, [BASE_TEST_PATH, BAD_TEST_ENVIRONMENT_NAME], LMDB_TEST_ERRORS.INVALID_ENVIRONMENT);
        });

        it('happy path', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.deleteEnvironment, [BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], undefined);

            let access_err;
            try{
                await fs.access(path.join(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME, 'data.mdb'));
            } catch(e){
                access_err = e;
            }

            assert(access_err.code === 'ENOENT');
            assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME], undefined);
        });
    });

        describe("Test createDBI function", ()=> {
            let env;
            beforeEach(async () => {
                global.lmdb_map = undefined;
                await fs.mkdirp(BASE_TEST_PATH);

                env = await lmdb_env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            });

            afterEach(async () => {
                await fs.remove(BASE_TEST_PATH);
                test_utils.tearDownMockFS();
                global.lmdb_map = undefined;
            });

            it('call function no args', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.createDBI, [], LMDB_TEST_ERRORS.ENV_REQUIRED);
            });

            it('call function no dbi_name', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.createDBI, [env], LMDB_TEST_ERRORS.DBI_NAME_REQUIRED);
            });

            it('call function with internal dbi name', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.createDBI, [env, lmdb_terms.INTERNAL_DBIS_NAME], LMDB_TEST_ERRORS.CANNOT_CREATE_INTERNAL_DBIS_NAME);
            });

            it('call function happy path', async ()=>{
                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.createDBI, [env, ID_DBI_NAME, false, undefined, true], undefined);
                assert.notDeepStrictEqual(dbi, undefined);
                assert(dbi.constructor.name === 'Dbi');

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME], undefined);
                assert.deepStrictEqual(env, global.lmdb_map[CACHED_ENV_NAME]);

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], undefined);
                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], dbi);

                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME][lmdb_terms.DBI_DEFINITION_NAME], new DBIDefinition(false, lmdb_terms.DBI_KEY_TYPES.STRING, true));
            });

            it('call function with dup_sort = true', async ()=>{
                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.createDBI, [env, ID_DBI_NAME, true], undefined);
                assert.notDeepStrictEqual(dbi, undefined);
                assert(dbi.constructor.name === 'Dbi');

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME], undefined);
                assert.deepStrictEqual(env, global.lmdb_map[CACHED_ENV_NAME]);

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], undefined);
                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], dbi);

                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME][lmdb_terms.DBI_DEFINITION_NAME], new DBIDefinition(true, lmdb_terms.DBI_KEY_TYPES.STRING, false));

                let dbi_def = await test_utils.assertErrorAsync(get_dbi_definition, [env, ID_DBI_NAME], undefined);
                assert.deepStrictEqual(dbi_def, new DBIDefinition(true, lmdb_terms.DBI_KEY_TYPES.STRING));
            });

            it('call function with dup_key & key_type = NUMBER', async ()=>{
                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.createDBI, [env, ID_DBI_NAME, true, lmdb_terms.DBI_KEY_TYPES.NUMBER], undefined);
                assert.notDeepStrictEqual(dbi, undefined);
                assert(dbi.constructor.name === 'Dbi');

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME], undefined);
                assert.deepStrictEqual(env, global.lmdb_map[CACHED_ENV_NAME]);

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], undefined);
                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], dbi);

                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME][lmdb_terms.DBI_DEFINITION_NAME], new DBIDefinition(true, lmdb_terms.DBI_KEY_TYPES.NUMBER));
                let dbi_def = await test_utils.assertErrorAsync(get_dbi_definition, [env, ID_DBI_NAME], undefined);
                assert.deepStrictEqual(dbi_def, new DBIDefinition(true, lmdb_terms.DBI_KEY_TYPES.NUMBER));
            });

            it('call function with dup_key = false & key_type = NUMBER', async ()=>{
                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.createDBI, [env, ID_DBI_NAME, false, lmdb_terms.DBI_KEY_TYPES.NUMBER], undefined);
                assert.notDeepStrictEqual(dbi, undefined);
                assert(dbi.constructor.name === 'Dbi');

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME], undefined);
                assert.deepStrictEqual(env, global.lmdb_map[CACHED_ENV_NAME]);

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], undefined);
                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], dbi);

                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME][lmdb_terms.DBI_DEFINITION_NAME], new DBIDefinition(false, lmdb_terms.DBI_KEY_TYPES.NUMBER));
                let dbi_def = await test_utils.assertErrorAsync(get_dbi_definition, [env, ID_DBI_NAME], undefined);
                assert.deepStrictEqual(dbi_def, new DBIDefinition(false, lmdb_terms.DBI_KEY_TYPES.NUMBER));
            });

            it('call function with dup_key = false & key_type = STRING', async ()=>{
                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.createDBI, [env, ID_DBI_NAME, false, lmdb_terms.DBI_KEY_TYPES.STRING], undefined);
                assert.notDeepStrictEqual(dbi, undefined);
                assert(dbi.constructor.name === 'Dbi');

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME], undefined);
                assert.deepStrictEqual(env, global.lmdb_map[CACHED_ENV_NAME]);

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], undefined);
                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], dbi);

                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME][lmdb_terms.DBI_DEFINITION_NAME], new DBIDefinition(false, lmdb_terms.DBI_KEY_TYPES.STRING));

                let dbi_def = await test_utils.assertErrorAsync(get_dbi_definition, [env, ID_DBI_NAME], undefined);
                assert.deepStrictEqual(dbi_def, new DBIDefinition(false, lmdb_terms.DBI_KEY_TYPES.STRING));
            });

            it('call function on existing dbi', async ()=>{
                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.createDBI, [env, ID_DBI_NAME, true], undefined);
                assert.notDeepStrictEqual(dbi, undefined);
                assert(dbi.constructor.name === 'Dbi');

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME], undefined);
                assert.deepStrictEqual(env, global.lmdb_map[CACHED_ENV_NAME]);

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], undefined);
                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], dbi);

                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME][lmdb_terms.DBI_DEFINITION_NAME], new DBIDefinition(true, lmdb_terms.DBI_KEY_TYPES.STRING));


                let dbi2 = await test_utils.assertErrorAsync(lmdb_env_util.createDBI, [env, ID_DBI_NAME], undefined);

                assert.notDeepStrictEqual(dbi, undefined);
                assert.deepStrictEqual(dbi, dbi2);
                assert(dbi.constructor.name === 'Dbi');

                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME][lmdb_terms.DBI_DEFINITION_NAME], new DBIDefinition(true, lmdb_terms.DBI_KEY_TYPES.STRING));
            });
        });

        describe("Test openDBI function", ()=> {
            let env;
            before(async () => {
                global.lmdb_map = undefined;
                await fs.mkdirp(BASE_TEST_PATH);

                env = await lmdb_env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
                await lmdb_env_util.createDBI(env, ID_DBI_NAME, true, lmdb_terms.DBI_KEY_TYPES.STRING);
            });

            after(async () => {
                await fs.remove(BASE_TEST_PATH);
                test_utils.tearDownMockFS();
                global.lmdb_map = undefined;
            });

            it('call function no args', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.openDBI, [], LMDB_TEST_ERRORS.ENV_REQUIRED);
            });

            it('call function no dbi_name', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.openDBI, [env], LMDB_TEST_ERRORS.DBI_NAME_REQUIRED);
            });

            it('call function happy path', async ()=>{
                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.openDBI, [env, ID_DBI_NAME], undefined);
                assert.notDeepStrictEqual(dbi, undefined);
                assert(dbi.constructor.name === 'Dbi');

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME], undefined);
                assert.deepStrictEqual(env, global.lmdb_map[CACHED_ENV_NAME]);

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], undefined);
                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], dbi);

                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME][lmdb_terms.DBI_DEFINITION_NAME], new DBIDefinition(true, lmdb_terms.DBI_KEY_TYPES.STRING));
            });

            it('call function dbi not initialized', async ()=>{
                //this clears the dbi from cache
                env.dbis[ID_DBI_NAME] = undefined;

                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.openDBI, [env, ID_DBI_NAME], undefined);
                assert.notDeepStrictEqual(dbi, undefined);
                assert(dbi.constructor.name === 'Dbi');

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME], undefined);
                assert.deepStrictEqual(env, global.lmdb_map[CACHED_ENV_NAME]);

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], undefined);
                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], dbi);

                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME][lmdb_terms.DBI_DEFINITION_NAME], new DBIDefinition(true, lmdb_terms.DBI_KEY_TYPES.STRING));
            });

            it('call function on dbi no exist', async ()=>{
                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.openDBI, [env, 'id2'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
                assert.deepStrictEqual(dbi, undefined);
            });
        });

        describe("Test listDBIDefinitions function", ()=> {
            let env;
            let env2;
            before(async () => {
                global.lmdb_map = undefined;
                await fs.mkdirp(BASE_TEST_PATH);

                env = await lmdb_env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
                env2 = await lmdb_env_util.createEnvironment(BASE_TEST_PATH, BAD_TEST_ENVIRONMENT_NAME);
                await lmdb_env_util.createDBI(env, ID_DBI_NAME, false, undefined, true);
                await lmdb_env_util.createDBI(env, 'temperature', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            });

            after(async () => {
                await fs.remove(BASE_TEST_PATH);
                test_utils.tearDownMockFS();
                global.lmdb_map = undefined;
            });

            it('call function no args', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.listDBIDefinitions, [], LMDB_TEST_ERRORS.ENV_REQUIRED);
            });

            it('call function happy path', async ()=>{
                let dbis = await test_utils.assertErrorAsync(lmdb_env_util.listDBIDefinitions, [env], undefined);

                let expected = Object.create(null);
                expected.id = new DBIDefinition(false, lmdb_terms.DBI_KEY_TYPES.STRING, true);
                expected.temperature = new DBIDefinition(true, lmdb_terms.DBI_KEY_TYPES.NUMBER, false);

                assert.deepStrictEqual(expected, dbis);
            });

            it('call function no dbis', async ()=>{
                let dbis = await test_utils.assertErrorAsync(lmdb_env_util.listDBIDefinitions, [env2], undefined);
                assert.deepStrictEqual(dbis, Object.create(null));
            });
        });

    describe("Test listDBIs function", ()=> {
        let env;
        let env2;
        before(async () => {
            global.lmdb_map = undefined;
            await fs.mkdirp(BASE_TEST_PATH);

            env = await lmdb_env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            env2 = await lmdb_env_util.createEnvironment(BASE_TEST_PATH, BAD_TEST_ENVIRONMENT_NAME);
            await lmdb_env_util.createDBI(env, ID_DBI_NAME, true, true);
            await lmdb_env_util.createDBI(env, 'temperature', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
        });

        after(async () => {
            await fs.remove(BASE_TEST_PATH);
            test_utils.tearDownMockFS();
            global.lmdb_map = undefined;
        });

        it('call function no args', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.listDBIs, [], LMDB_TEST_ERRORS.ENV_REQUIRED);
        });

        it('call function happy path', async ()=>{
            let dbis = await test_utils.assertErrorAsync(lmdb_env_util.listDBIs, [env], undefined);

            assert.deepStrictEqual(dbis, ['id', 'temperature']);
        });

        it('call function no dbis', async ()=>{
            let dbis = await test_utils.assertErrorAsync(lmdb_env_util.listDBIs, [env2], undefined);
            assert.deepStrictEqual(dbis, []);
        });
    });

        describe("Test statDBI function", ()=> {
            let env;
            before(async () => {
                global.lmdb_map = undefined;
                await fs.mkdirp(BASE_TEST_PATH);

                env = await lmdb_env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
                await lmdb_env_util.createDBI(env, ID_DBI_NAME);
            });

            after(async () => {
                await fs.remove(BASE_TEST_PATH);
                test_utils.tearDownMockFS();
                global.lmdb_map = undefined;
            });

            it('call function no args', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.statDBI, [], LMDB_TEST_ERRORS.ENV_REQUIRED);
            });

            it('call function no dbi_name', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.statDBI, [env], LMDB_TEST_ERRORS.DBI_NAME_REQUIRED);
            });

            it('call function happy path', async ()=>{
                let stat = await test_utils.assertErrorAsync(lmdb_env_util.statDBI, [env, ID_DBI_NAME], undefined);
                assert.notDeepStrictEqual(stat, undefined);
                assert.deepStrictEqual(stat, {
                    "pageSize": 4096,
                    "treeDepth": 0,
                    "treeBranchPageCount": 0,
                    "treeLeafPageCount": 0,
                    "entryCount": 0,
                    "overflowPages": 0
                });
            });

            it('call function on dbi no exist', async ()=>{
                let stat = await test_utils.assertErrorAsync(lmdb_env_util.statDBI, [env, 'id2'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
                assert.deepStrictEqual(stat, undefined);
            });
        });

        describe("Test dropDBI function", ()=> {
            let env;
            before(async () => {
                global.lmdb_map = undefined;
                await fs.mkdirp(BASE_TEST_PATH);

                env = await lmdb_env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
                await lmdb_env_util.createDBI(env, ID_DBI_NAME);
            });

            after(async () => {
                await fs.remove(BASE_TEST_PATH);
                test_utils.tearDownMockFS();
                global.lmdb_map = undefined;
            });

            it('call function no args', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.dropDBI, [], LMDB_TEST_ERRORS.ENV_REQUIRED);
            });

            it('call function no dbi_name', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.dropDBI, [env], LMDB_TEST_ERRORS.DBI_NAME_REQUIRED);
            });

            it('call function with internal dbi name', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.dropDBI, [env, lmdb_terms.INTERNAL_DBIS_NAME], LMDB_TEST_ERRORS.CANNOT_DROP_INTERNAL_DBIS_NAME);
            });

            it('call function happy path', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.dropDBI, [env, ID_DBI_NAME], undefined);

                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.openDBI, [env, ID_DBI_NAME], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
                assert.deepStrictEqual(dbi, undefined);

                assert.notDeepStrictEqual(global.lmdb_map[CACHED_ENV_NAME], undefined);
                assert.deepStrictEqual(env, global.lmdb_map[CACHED_ENV_NAME]);

                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], undefined);
                assert.deepStrictEqual(global.lmdb_map[CACHED_ENV_NAME].dbis[ID_DBI_NAME], dbi);

            });

            it('call function on dbi no exist', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.dropDBI, [env, 'id2'], LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST);
            });
        });

    describe("Test initializeDBIs function", ()=>{
        let env;
        before(async ()=>{
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await lmdb_env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await lmdb_env_util.createDBI(env, 'id');
        });

        after(async ()=>{
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("pass valid env hash_attribute all_attributes", ()=>{
            test_utils.assertErrorSync(lmdb_env_util.initializeDBIs, [env, ID_DBI_NAME, [ID_DBI_NAME]], undefined);
        });

        it('test with new attributes', ()=>{
            let list_e;
            let dbis;
            try{
                dbis = lmdb_env_util.listDBIDefinitions(env);
            }catch (e) {
                list_e = e;
            }

            let expected = Object.create(null);
            expected.id = new DBIDefinition(false, lmdb_terms.DBI_KEY_TYPES.STRING, false);

            assert.deepStrictEqual(list_e, undefined);
            assert.deepStrictEqual(dbis, expected);

            let err;
            try{
                lmdb_env_util.initializeDBIs(env, ID_DBI_NAME, ALL_ATTRIBUTES);
            }catch (e) {
                err = e;
            }

            assert.deepStrictEqual(err, undefined);

            let list_err;
            try{
                dbis = lmdb_env_util.listDBIDefinitions(env);
            }catch (e) {
                list_err = e;
            }

            expected.age = new DBIDefinition(true, lmdb_terms.DBI_KEY_TYPES.STRING);
            expected.name = new DBIDefinition(true, lmdb_terms.DBI_KEY_TYPES.STRING);
            assert.deepStrictEqual(list_err, undefined);
            assert.deepStrictEqual(dbis, expected);
        });
    });


});
