'use strict';

const test_utils = require('../test_utils');
test_utils.preTestPrep();
const path = require('path');
const fs = require('fs-extra');
const env_mngr = require('../../utility/environment/environmentManager');
const environment_utility = require('../../utility/lmdb/environmentUtility');
const hdb_terms = require('../../utility/hdbTerms');
const system_schema = require('../../json/systemSchema');
const assert = require('assert');
const rewire = require('rewire');
const mount = require('../../utility/mount_hdb');
const promisify = require('util').promisify;
const p_mount = promisify(mount);
const rw_mount = rewire('../../utility/mount_hdb');
const winston = require('winston');

const create_fs_tables = rw_mount.__get__('createFSTables');
const create_lmdb_tables = rw_mount.__get__('createLMDBTables');

const BASE_BATH = env_mngr.getHdbBasePath();
const BASE_SCHEMA_PATH = path.join(BASE_BATH, hdb_terms.SCHEMA_DIR_NAME);
const SYSTEM_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, hdb_terms.SYSTEM_SCHEMA_NAME);

describe('test mount_hdb module', ()=>{
    before(async()=>{
        await fs.mkdirp(BASE_BATH);

        winston.configure({
            transports: [
                new (winston.transports.File)({
                    filename: path.join(BASE_BATH, 'install.log'),
                    level: 'verbose',
                    handleExceptions: true,
                    prettyPrint: true
                })
            ],
            exitOnError: false
        });
    });

    after(async ()=>{
        await fs.remove(BASE_BATH);
    });

    describe('test createFSTables', ()=>{
        before(async()=>{
            await fs.mkdirp(SYSTEM_SCHEMA_PATH);
        });

        after(async()=>{
            await fs.remove(BASE_SCHEMA_PATH);
        });

        it('happy path', async ()=>{
            let err;
            try {
                create_fs_tables(SYSTEM_SCHEMA_PATH, winston);
            }catch(e){
                err = e;
            }
            assert.deepStrictEqual(err, undefined);

            let tables = Object.keys(system_schema);
            for(let x = 0; x < tables.length; x++) {
                let table_name = tables[x];

                let attributes = system_schema[table_name].attributes;

                for(let y = 0; y < attributes.length; y++){
                    let error;
                    try{
                        await fs.access(path.join(SYSTEM_SCHEMA_PATH, table_name, attributes[y].attribute));
                    }catch (e) {
                        error = e;
                    }
                    assert.deepStrictEqual(error, undefined);
                }
            }
        });
    });

    describe('test createLMDBTables', ()=>{
        before(async()=>{
            await fs.mkdirp(SYSTEM_SCHEMA_PATH);
        });

        after(async()=>{
            await fs.remove(BASE_SCHEMA_PATH);
        });

        it('happy path', async ()=>{
            let err;
            try {
                await create_lmdb_tables(SYSTEM_SCHEMA_PATH, winston);
            }catch(e){
                err = e;
            }
            assert.deepStrictEqual(err, undefined);

            let tables = Object.keys(system_schema);
            for(let x = 0; x < tables.length; x++) {
                let table_name = tables[x];
                let env;
                let all_dbis;
                let error;
                try {
                    env = await environment_utility.openEnvironment(SYSTEM_SCHEMA_PATH, table_name);
                    all_dbis = environment_utility.listDBIs(env);
                }catch(e){
                    error = e;
                }
                assert.deepStrictEqual(error, undefined);
                assert.notDeepStrictEqual(env, undefined);
                assert.notDeepStrictEqual(all_dbis, undefined);
                system_schema[table_name].attributes.forEach(attribute=>{
                    assert(all_dbis.indexOf(attribute.attribute) >= 0);
                });
            }
        });
    });

    describe('test module', ()=>{
        before(()=>{
            try {
                fs.unlinkSync(path.join(BASE_BATH, 'install.log'));
            }catch(e){
            }
        });
        it('test mounting with FS', async ()=>{
            let err;
            try {
                p_mount(winston, BASE_BATH);
            } catch(e){
                err = e;
            }
            assert.deepStrictEqual(err, undefined);

            let top_folders = undefined;
            let error =undefined;
            try{
                top_folders = await fs.readdir(BASE_BATH);
            } catch (e) {
                error = e;
            }

            let expected_folders = ['backup', 'trash', 'keys', 'log', 'config', 'doc', 'schema', 'transactions', 'clustering'];
            assert.deepStrictEqual(error, undefined);
            assert.notDeepStrictEqual(top_folders, undefined);
            assert.deepStrictEqual(top_folders.sort(), expected_folders.sort());

            let tables = Object.keys(system_schema);
            for(let x = 0; x < tables.length; x++) {
                let table_name = tables[x];

                let attributes = system_schema[table_name].attributes;

                for(let y = 0; y < attributes.length; y++){
                    let err;
                    try{
                        await fs.access(path.join(SYSTEM_SCHEMA_PATH, table_name, attributes[y].attribute));
                    }catch (e) {
                        err = e;
                    }
                    assert.deepStrictEqual(err, undefined);
                }
            }
        });
    });
});