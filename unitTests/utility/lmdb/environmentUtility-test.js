"use strict";

const lmdb_env_util = require('../../../utility/lmdb/environmentUtility');
const rewire = require('rewire');
const rw_lmdb_env_util = rewire('../../../utility/lmdb/environmentUtility');
const assert = require('assert');
const path = require('path');
const test_utils = require('../../test_utils');
const fs = require('fs-extra');

const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'lmdbTest');
const INVALID_BASE_TEST_PATH = '/bad/path/zzz/';
const TEST_ENVIRONMENT_NAME = 'test';
const BAD_TEST_ENVIRONMENT_NAME = 'bad_test';
const ID_DBI_NAME = 'id';

const BASE_PATH_REQUIRED_ERROR = new Error('base_path is required');
const ENV_NAME_REQUIRED_ERROR = new Error('env_name is required');
const INVALID_BASE_PATH_ERROR = new Error('invalid base_path');
const INVALID_ENVIRONMENT_ERROR = new Error('invalid environment');
const ENV_REQUIRED_ERROR = new Error('env is required');
const DBI_NAME_REQUIRED_ERROR = new Error('dbi_name is required');
const DBI_NO_EXIST_ERROR = new Error('dbi does not exist');


describe("Test LMDB environmentUtility module", ()=>{
    before(async()=>{
        await fs.mkdirp(BASE_TEST_PATH);
        global.lmdb_map = undefined;
    });

    after(async ()=>{
        await fs.remove(BASE_TEST_PATH);
        global.lmdb_map = undefined;
    });

    describe("Test pathEnvNameValidation function", ()=>{
        let rw_validator;
        before(()=>{
            rw_validator = rw_lmdb_env_util.__get__('pathEnvNameValidation');
        });

        it('call function no args', async ()=>{
            await test_utils.assertErrorAsync(rw_validator, [], BASE_PATH_REQUIRED_ERROR, 'no args');
        });

        it('call function no env_name', async()=>{
            await test_utils.assertErrorAsync(rw_validator, [BASE_TEST_PATH], ENV_NAME_REQUIRED_ERROR, 'no env_name');
        });

        it('call function invalid base_path', async ()=>{
            await test_utils.assertErrorAsync(rw_validator, [INVALID_BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], INVALID_BASE_PATH_ERROR, 'invalid base_path');
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
            await test_utils.assertErrorAsync(rw_validator, [INVALID_BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], INVALID_ENVIRONMENT_ERROR, 'invalid base_path');
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
            await test_utils.assertErrorAsync(rw_validator, [], ENV_REQUIRED_ERROR, 'no args');
        });

        it('call function no dbi_name', async ()=>{
            await test_utils.assertErrorAsync(rw_validator, [env], DBI_NAME_REQUIRED_ERROR, 'no dbi_name');
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
            await test_utils.assertErrorAsync(lmdb_env_util.createEnvironment, [], BASE_PATH_REQUIRED_ERROR, 'no args');
        });

        it('call function no env_name', async()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.createEnvironment, [BASE_TEST_PATH], ENV_NAME_REQUIRED_ERROR, 'no env_name');
        });

        it('call function invalid base_path', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.createEnvironment, [INVALID_BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], INVALID_BASE_PATH_ERROR, 'invalid base_path');
        });

        it('call function happy path', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.createEnvironment, [BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], undefined, 'happy path');

            await test_utils.assertErrorAsync(await fs.access, [path.join(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME, 'data.mdb')], undefined, 'test path exists');

            assert.notDeepStrictEqual(global.lmdb_map, undefined);
            assert.notDeepStrictEqual(global.lmdb_map[TEST_ENVIRONMENT_NAME], undefined);
        });

        it('create existing environment', async ()=>{
            global.lmdb_map = undefined;

            await test_utils.assertErrorAsync(lmdb_env_util.createEnvironment, [BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], undefined);

            await test_utils.assertErrorAsync(await fs.access, [path.join(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME, 'data.mdb')], undefined, 'test path exists');

            assert.notDeepStrictEqual(global.lmdb_map, undefined);
            assert.notDeepStrictEqual(global.lmdb_map[TEST_ENVIRONMENT_NAME], undefined);
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
            await test_utils.assertErrorAsync(lmdb_env_util.openEnvironment, [], BASE_PATH_REQUIRED_ERROR);
        });

        it('call function no env_name', async()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.openEnvironment, [BASE_TEST_PATH], ENV_NAME_REQUIRED_ERROR);
        });

        it('call function invalid base_path', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.openEnvironment, [INVALID_BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], INVALID_BASE_PATH_ERROR);
        });

        it('open non-existent environment', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.openEnvironment, [BASE_TEST_PATH, BAD_TEST_ENVIRONMENT_NAME], INVALID_ENVIRONMENT_ERROR);
        });

        it('happy path test', async ()=>{
            let env = await test_utils.assertErrorAsync(lmdb_env_util.openEnvironment, [BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], undefined);

            assert.notDeepStrictEqual(env, undefined);
            assert.notDeepStrictEqual(global.lmdb_map[TEST_ENVIRONMENT_NAME], undefined);
            assert.deepStrictEqual(env, global.lmdb_map[TEST_ENVIRONMENT_NAME]);
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
            await test_utils.assertErrorAsync(lmdb_env_util.deleteEnvironment, [], BASE_PATH_REQUIRED_ERROR);
        });

        it('call function no env_name', async()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.deleteEnvironment, [BASE_TEST_PATH], ENV_NAME_REQUIRED_ERROR);
        });

        it('call function invalid base_path', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.deleteEnvironment, [INVALID_BASE_TEST_PATH, TEST_ENVIRONMENT_NAME], INVALID_BASE_PATH_ERROR);
        });

        it('call function invalid environment', async ()=>{
            await test_utils.assertErrorAsync(lmdb_env_util.deleteEnvironment, [BASE_TEST_PATH, BAD_TEST_ENVIRONMENT_NAME], INVALID_ENVIRONMENT_ERROR);
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
            assert.deepStrictEqual(global.lmdb_map[TEST_ENVIRONMENT_NAME], undefined);
        });
    });

        describe("Test createDBI function", ()=> {
            let env;
            before(async () => {
                global.lmdb_map = undefined;
                await fs.mkdirp(BASE_TEST_PATH);

                env = await lmdb_env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            });

            after(async () => {
                await fs.remove(BASE_TEST_PATH);
                test_utils.tearDownMockFS();
                global.lmdb_map = undefined;
            });

            it('call function no args', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.createDBI, [], ENV_REQUIRED_ERROR);
            });

            it('call function no dbi_name', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.createDBI, [env], DBI_NAME_REQUIRED_ERROR);
            });

            it('call function happy path', async ()=>{
                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.createDBI, [env, ID_DBI_NAME], undefined);
                assert.notDeepStrictEqual(dbi, undefined);
                assert(dbi.constructor.name === 'Dbi');
            });

            it('call function on existing dbi', async ()=>{
                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.createDBI, [env, ID_DBI_NAME], undefined);

                assert.notDeepStrictEqual(dbi, undefined);
                assert(dbi.constructor.name === 'Dbi');
            });
        });

        describe("Test openDBI function", ()=> {
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
                await test_utils.assertErrorAsync(lmdb_env_util.openDBI, [], ENV_REQUIRED_ERROR);
            });

            it('call function no dbi_name', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.openDBI, [env], DBI_NAME_REQUIRED_ERROR);
            });

            it('call function happy path', async ()=>{
                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.openDBI, [env, ID_DBI_NAME], undefined);
                assert.notDeepStrictEqual(dbi, undefined);
                assert(dbi.constructor.name === 'Dbi');
            });

            it('call function dbi not initialized', async ()=>{
                //this clears the dbi from cache
                env.dbis[ID_DBI_NAME] = undefined;

                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.openDBI, [env, ID_DBI_NAME], undefined);
                assert.notDeepStrictEqual(dbi, undefined);
                assert(dbi.constructor.name === 'Dbi');
            });

            it('call function on dbi no exist', async ()=>{
                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.openDBI, [env, 'id2'], DBI_NO_EXIST_ERROR);
                assert.deepStrictEqual(dbi, undefined);
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
                await lmdb_env_util.createDBI(env, ID_DBI_NAME, true);
            });

            after(async () => {
                await fs.remove(BASE_TEST_PATH);
                test_utils.tearDownMockFS();
                global.lmdb_map = undefined;
            });

            it('call function no args', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.listDBIs, [], ENV_REQUIRED_ERROR);
            });

            it('call function happy path', async ()=>{
                let dbis = await test_utils.assertErrorAsync(lmdb_env_util.listDBIs, [env], undefined);

                assert.deepStrictEqual(dbis, [ID_DBI_NAME]);
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
                await test_utils.assertErrorAsync(lmdb_env_util.statDBI, [], ENV_REQUIRED_ERROR);
            });

            it('call function no dbi_name', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.statDBI, [env], DBI_NAME_REQUIRED_ERROR);
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
                let stat = await test_utils.assertErrorAsync(lmdb_env_util.statDBI, [env, 'id2'], DBI_NO_EXIST_ERROR);
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
                await test_utils.assertErrorAsync(lmdb_env_util.dropDBI, [], ENV_REQUIRED_ERROR);
            });

            it('call function no dbi_name', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.dropDBI, [env], DBI_NAME_REQUIRED_ERROR);
            });

            it('call function happy path', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.dropDBI, [env, ID_DBI_NAME], undefined);

                let dbi = await test_utils.assertErrorAsync(lmdb_env_util.openDBI, [env, ID_DBI_NAME], DBI_NO_EXIST_ERROR);
                assert.deepStrictEqual(dbi, undefined);
            });

            it('call function on dbi no exist', async ()=>{
                await test_utils.assertErrorAsync(lmdb_env_util.dropDBI, [env, 'id2'], DBI_NO_EXIST_ERROR);
            });
        });


});
