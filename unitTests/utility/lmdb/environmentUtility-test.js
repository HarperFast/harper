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
            let err;
            try{
                await rw_validator();
            } catch(e){
                err = e;
            }

            assert.deepEqual(err, BASE_PATH_REQUIRED_ERROR);
        });

        it('call function no env_name', async()=>{
            let err;
            try {
                await rw_validator(BASE_TEST_PATH);
            }catch(e){
                err = e;
            }

            assert.deepEqual(err, ENV_NAME_REQUIRED_ERROR);
        });

        it('call function invalid base_path', async ()=>{
            let err;
            try {
                await rw_validator(INVALID_BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            }catch(e){
                err = e;
            }

            assert.deepEqual(err, INVALID_BASE_PATH_ERROR);
        });

        it('call function happy path', async ()=>{
            let err;
            try {
                await rw_validator(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            }catch(e){
                err = e;
            }

            assert.deepEqual(err, undefined);
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
            let err;
            try {
                await rw_validator(INVALID_BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            }catch(e){
                err = e;
            }

            assert.deepEqual(err, INVALID_ENVIRONMENT_ERROR);
        });

        it('call function happy path', async ()=>{
            let err;
            try {
                await rw_validator(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            }catch(e){
                err = e;
            }

            assert.deepEqual(err, undefined);
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
            let err;
            try {
                await rw_validator();
            }catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, ENV_REQUIRED_ERROR);
        });

        it('call function no dbi_name', async ()=>{
            let err;
            try {
                await rw_validator(env);
            }catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, DBI_NAME_REQUIRED_ERROR);
        });

        it('call function happy path', async ()=>{
            let err;
            try {
                await rw_validator(env, ID_DBI_NAME);
            }catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);
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
            let err;
            try{
                await lmdb_env_util.createEnvironment();
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, BASE_PATH_REQUIRED_ERROR);
        });

        it('call function no env_name', async()=>{
            let err;
            try {
                await lmdb_env_util.createEnvironment(BASE_TEST_PATH);
            }catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, ENV_NAME_REQUIRED_ERROR);
        });

        it('call function invalid base_path', async ()=>{
            let err;
            try {
                await lmdb_env_util.createEnvironment(INVALID_BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            }catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, INVALID_BASE_PATH_ERROR);
        });

        it('call function happy path', async ()=>{
            let env_err;
            try {
                await lmdb_env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            } catch(e){
                env_err = e;
            }

            assert.deepStrictEqual(env_err, undefined);

            let err;
            try {
                await fs.access(path.join(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME, 'data.mdb'));
            }catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);

            assert.notDeepStrictEqual(global.lmdb_map, undefined);
            assert.notDeepStrictEqual(global.lmdb_map[TEST_ENVIRONMENT_NAME], undefined);
        });

        it('create existing environment', async ()=>{
            global.lmdb_map = undefined;
            let env_err;
            try {
                await lmdb_env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            } catch(e){
                env_err = e;
            }

            assert.deepStrictEqual(env_err, undefined);

            let err;
            try {
                await fs.access(path.join(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME, 'data.mdb'));
            }catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);

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
            let err;
            try{
                await lmdb_env_util.openEnvironment();
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, BASE_PATH_REQUIRED_ERROR);
        });

        it('call function no env_name', async()=>{
            let err;
            try {
                await lmdb_env_util.openEnvironment(BASE_TEST_PATH);
            }catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, ENV_NAME_REQUIRED_ERROR);
        });

        it('call function invalid base_path', async ()=>{
            let err;
            try {
                await lmdb_env_util.openEnvironment(INVALID_BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            }catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, INVALID_BASE_PATH_ERROR);
        });

        it('open non-existent environment', async ()=>{
            let err;
            try {
                await lmdb_env_util.openEnvironment(BASE_TEST_PATH, BAD_TEST_ENVIRONMENT_NAME);
            }catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, INVALID_ENVIRONMENT_ERROR);
        });

        it('happy path test', async ()=>{
            let err;
            let env;
            try {
                env = await lmdb_env_util.openEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            }catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);
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
            let err;
            try{
                await lmdb_env_util.deleteEnvironment();
            } catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, BASE_PATH_REQUIRED_ERROR);
        });

        it('call function no env_name', async()=>{
            let err;
            try {
                await lmdb_env_util.deleteEnvironment(BASE_TEST_PATH);
            }catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, ENV_NAME_REQUIRED_ERROR);
        });

        it('call function invalid base_path', async ()=>{
            let err;
            try {
                await lmdb_env_util.deleteEnvironment(INVALID_BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            }catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, INVALID_BASE_PATH_ERROR);
        });

        it('call function invalid environment', async ()=>{
            let err;
            try {
                await lmdb_env_util.deleteEnvironment(BASE_TEST_PATH, BAD_TEST_ENVIRONMENT_NAME);
            }catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, INVALID_ENVIRONMENT_ERROR);
        });

        it('happy path', async ()=>{
            let err;
            try {
                await lmdb_env_util.deleteEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            }catch(e){
                err = e;
            }

            assert.deepStrictEqual(err, undefined);

            let access_err;
            try{
                await fs.access(path.join(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME, 'data.mdb'));
            } catch(e){
                access_err = e;
            }

            assert(access_err.code === 'ENOENT');
            assert.deepStrictEqual(global.lmdb_map[TEST_ENVIRONMENT_NAME], undefined);
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
                let err;
                try {
                    await lmdb_env_util.createDBI();
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, ENV_REQUIRED_ERROR);
            });

            it('call function no dbi_name', async ()=>{
                let err;
                try {
                    await lmdb_env_util.createDBI(env);
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, DBI_NAME_REQUIRED_ERROR);
            });

            it('call function happy path', async ()=>{
                let err;
                let dbi;
                try {
                    dbi = await lmdb_env_util.createDBI(env, ID_DBI_NAME);
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, undefined);
                assert.notDeepStrictEqual(dbi, undefined);
            });

            it('call function on existing dbi', async ()=>{
                let err;
                let dbi;
                try {
                    dbi = await lmdb_env_util.createDBI(env, ID_DBI_NAME, true);
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, undefined);
                assert.notDeepStrictEqual(dbi, undefined);
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
                let err;
                try {
                    await lmdb_env_util.openDBI();
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, ENV_REQUIRED_ERROR);
            });

            it('call function no dbi_name', async ()=>{
                let err;
                try {
                    await lmdb_env_util.openDBI(env);
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, DBI_NAME_REQUIRED_ERROR);
            });

            it('call function happy path', async ()=>{
                let err;
                let dbi;
                try {
                    dbi = await lmdb_env_util.openDBI(env, ID_DBI_NAME);
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, undefined);
                assert.notDeepStrictEqual(dbi, undefined);
            });

            it('call function dbi not initialized', async ()=>{
                env.dbis[ID_DBI_NAME] = undefined;
                let err;
                let dbi;
                try {
                    dbi = await lmdb_env_util.openDBI(env, ID_DBI_NAME);
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, undefined);
                assert.notDeepStrictEqual(dbi, undefined);
            });

            it('call function on dbi no exist', async ()=>{
                let err;
                let dbi;
                try {
                    dbi = await lmdb_env_util.openDBI(env, 'id2');
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, DBI_NO_EXIST_ERROR);
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
                let err;
                try {
                    await lmdb_env_util.listDBIs();
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, ENV_REQUIRED_ERROR);
            });

            it('call function happy path', async ()=>{
                let err;
                let dbis;
                try {
                    dbis = await lmdb_env_util.listDBIs(env);
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, undefined);
                assert.deepStrictEqual(dbis, [ID_DBI_NAME]);
            });

            it('call function no dbis', async ()=>{
                let err;
                let dbis;
                try {
                    dbis = await lmdb_env_util.listDBIs(env2);
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, undefined);
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
                let err;
                try {
                    await lmdb_env_util.statDBI();
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, ENV_REQUIRED_ERROR);
            });

            it('call function no dbi_name', async ()=>{
                let err;
                try {
                    await lmdb_env_util.statDBI(env);
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, DBI_NAME_REQUIRED_ERROR);
            });

            it('call function happy path', async ()=>{
                let err;
                let stat;
                try {
                    stat = await lmdb_env_util.statDBI(env, ID_DBI_NAME);
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, undefined);
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
                let err;
                let stat;
                try {
                    stat = await lmdb_env_util.statDBI(env, 'id2');
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, DBI_NO_EXIST_ERROR);
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
                let err;
                try {
                    await lmdb_env_util.dropDBI();
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, ENV_REQUIRED_ERROR);
            });

            it('call function no dbi_name', async ()=>{
                let err;
                try {
                    await lmdb_env_util.dropDBI(env);
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, DBI_NAME_REQUIRED_ERROR);
            });

            it('call function happy path', async ()=>{
                let err;
                try {
                    await lmdb_env_util.dropDBI(env, ID_DBI_NAME);
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, undefined);

                let open_err;
                let dbi;
                try{
                    dbi = lmdb_env_util.openDBI(env, ID_DBI_NAME);
                }catch (e) {
                    open_err = e;
                }

                assert.deepStrictEqual(dbi, undefined);
                assert.deepStrictEqual(open_err, DBI_NO_EXIST_ERROR);

            });

            it('call function on dbi no exist', async ()=>{
                let err;
                try {
                    await lmdb_env_util.dropDBI(env, 'id2');
                }catch(e){
                    err = e;
                }

                assert.deepStrictEqual(err, DBI_NO_EXIST_ERROR);
            });
        });

    });
});
