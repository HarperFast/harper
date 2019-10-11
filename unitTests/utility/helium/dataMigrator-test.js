"use strict";

const assert = require('assert');
const rewire = require('rewire');
const data_migrator = rewire('../../../utility/helium/dataMigrator');
const SYSTEM_SCHEMA = 'system';
const HDB_TABLE = 'hdb_table';
const DEV_SCHEMA = 'dev';
const DOG_TABLE = 'dog';
const system_schema = require('../../../json/systemSchema');

const DOG_TABLE_INFO = {
    "hash_attribute":"id",
    "name":DOG_TABLE,
    "schema":DEV_SCHEMA,
    "attributes": [
        {
            "attribute": "id"
        },
        {
            "attribute": "name"
        }
    ]
};

const BLERG = 'blerg';

describe('Test dataMigrator', ()=>{
    describe('test schemaTableValidation', ()=>{
        let schema_table_validation;

        before(()=>{
            schema_table_validation = data_migrator.__get__('schemaTableValidation');
        });

        it('test empty call', ()=>{
            assert.throws(()=>{
                schema_table_validation();
            }, (err)=>{
                assert(err instanceof Error);
                assert(err.message === 'schema is required');
                return true;
            });
        });

        it('test schema & no table', ()=>{
            assert.throws(()=>{
                schema_table_validation(SYSTEM_SCHEMA);
            }, (err)=>{
                assert(err instanceof Error);
                assert(err.message === 'table is required');
                return true;
            });
        });

        it('test success', ()=>{
            assert.doesNotThrow(()=>{
                schema_table_validation(SYSTEM_SCHEMA, HDB_TABLE);
            }, (err)=>{
                assert(err === undefined);
                return true;
            });
        });
    });

    describe('test getTableInfo', ()=>{
        let get_table_info = undefined;
        before(()=>{
            get_table_info = data_migrator.__get__('getTableInfo');
        });

        it('test fetching a table that lives in systemSchema.json', async ()=>{
            let result = await get_table_info(SYSTEM_SCHEMA, HDB_TABLE);
            assert(result === system_schema[HDB_TABLE]);
        });

        it('test fetching a non-existent system table', async()=>{
            let result = await get_table_info(SYSTEM_SCHEMA, BLERG);
            assert(result === undefined);
        });

        it('test fetching a non system table', async()=>{
            let revert = data_migrator.__set__('fs_search_by_value', async(table_search_obj)=>{
                return [DOG_TABLE_INFO];
            });

            let result = await get_table_info(DEV_SCHEMA, DOG_TABLE);
            assert(result === DOG_TABLE_INFO);
            revert();
        });

        it('test fetching a non system table where the schemas don\'t match the search result', async()=>{
            let revert = data_migrator.__set__('fs_search_by_value', async(table_search_obj)=>{
                return [DOG_TABLE_INFO];
            });

            let result = await get_table_info(BLERG, DOG_TABLE);
            assert(result === undefined);
            revert();
        });

        it('test search throwing an error', async()=>{
            let revert = data_migrator.__set__('fs_search_by_value', async(table_search_obj)=>{
                throw new Error('oh no');
            });

            let result = await get_table_info(BLERG, DOG_TABLE);
            assert(result === undefined);
            revert();
        });
    });

    describe('test setGlobalSchema', ()=> {
        let set_global_schema;

        before(() => {
            set_global_schema = data_migrator.__get__('setGlobalSchema');
        });

        it('test pass no table_info', () => {
            assert.throws(() => {
                set_global_schema();
            }, (err) => {
                assert(err instanceof Error);
                assert(err.message === 'table_info is required');
                return true;
            });
        });

        it('test happy path', () => {
            set_global_schema(DOG_TABLE_INFO);
            assert(global.hdb_schema !== undefined);
            assert(global.hdb_schema[DOG_TABLE_INFO.schema] !== undefined);
            assert(global.hdb_schema[DOG_TABLE_INFO.schema][DOG_TABLE_INFO.name] === DOG_TABLE_INFO);
        });
    });

    describe('test getTableHashValues', ()=>{
        let get_table_hash_values;

        before(() => {
            get_table_hash_values = data_migrator.__get__('getTableHashValues');
        });

        it('test no table_info', async ()=>{
            await assert.rejects(async ()=>{
                await get_table_hash_values();
            }, (err)=>{
                assert(err instanceof Error);
                assert(err.message === 'table_info is required');
                return true;
            });
        });

        it('test path doesn\'t exist', async()=>{
            let fs_revert = data_migrator.__set__('fs', {
                readdir:async(path)=>{
                    let err = new Error('not found');
                    err.code = 'ENOENT';
                    throw err;
                }
            });

            let results = await get_table_hash_values(DOG_TABLE_INFO);
            assert(Array.isArray(results));
            assert(results.length === 0);
            fs_revert();
        });

        it('test readdir error', async()=>{
            let fs_revert = data_migrator.__set__('fs', {
                readdir:async(path)=>{
                    let err = new Error('oh no');
                    throw err;
                }
            });

            let results = await get_table_hash_values(DOG_TABLE_INFO);
            assert(Array.isArray(results));
            assert(results.length === 0);
            fs_revert();
        });

        it('test happy path', async()=>{
            let fs_revert = data_migrator.__set__('fs', {
                readdir:async(path)=>{
                    return ['1.hdb', '2.hdb', '3.hdb', '4.hdb'];
                }
            });

            let results = await get_table_hash_values(DOG_TABLE_INFO);
            assert(Array.isArray(results));
            assert(results.length === 4);
            assert.deepStrictEqual(results, ['1', '2', '3', '4']);
            fs_revert();
        });
    });

    describe('test searchAndInsert', ()=>{
        let search_and_insert;

        before(() => {
            search_and_insert = data_migrator.__get__('searchAndInsert');
        });

        it('happy path', async ()=>{
            let batch_revert = data_migrator.__set__('BATCH_SIZE', 1);

            let search_revert = data_migrator.__set__('fs_search_by_hash', async(search_obj)=>{
                return [
                    {id:1,name:'Penny'},
                    {id:2,name:'Kato'},
                    {id:3,name:'Harper'},
                    {id:4,name:'Monkey'}
                ];
            });

            let insert_revert = data_migrator.__set__('he_insert_rows', async(search_obj)=>{
                return;
            });

            await assert.doesNotReject(async ()=>{
                await search_and_insert(DOG_TABLE_INFO, [1,2,3,4]);
            });

            search_revert();
            insert_revert();
            batch_revert();
        });
    });
});