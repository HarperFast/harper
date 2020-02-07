'use strict';

const path = require('path');
const env_mgr = require('../../../../../utility/environment/environmentManager');
if(!env_mgr.isInitialized()){
    env_mgr.initSync();
}
const test_utils = require('../../../../test_utils');
const SYSTEM_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const BASE_PATH = test_utils.getMockFSPath();
const BASE_SCHEMA_PATH = path.join(BASE_PATH, SCHEMA_NAME);
const SYSTEM_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, SYSTEM_FOLDER_NAME);
const DEV_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, 'dev');
const root_original = env_mgr.get('HDB_ROOT');
env_mgr.setProperty('HDB_ROOT', BASE_PATH);
const test_data = require('../../../../testData');

const rewire = require('rewire');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../../../utility/lmdb/writeUtility');
const SearchObject = require('../../../../../data_layer/SearchObject');
const lmdb_search = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbSearch');
const lmdb_terms = require('../../../../../utility/lmdb/terms');
const hdb_terms = require('../../../../../utility/hdbTerms');
const LMDB_ERRORS = require('../../../../commonTestErrors').LMDB_ERRORS_ENUM;
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');
const systemSchema = require('../../../../../json/systemSchema');

const TIMESTAMP = Date.now();

const sandbox = sinon.createSandbox();

const TIMESTAMP_OBJECT = {
    [hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME]: TIMESTAMP,
    [hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME]: TIMESTAMP,
};

const create_search_type_function = lmdb_search.__get__('createSearchTypeFromSearchObject');

describe('test lmdbSearch module', ()=>{
    let date_stub;
    let rw_env_util;
    before(()=>{
        rw_env_util = environment_utility.__set__('MAP_SIZE', 10*1024*1024*1024);
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
        env_mgr.setProperty('HDB_ROOT', BASE_PATH);
    });

    after(()=>{
        rw_env_util();
        date_stub.restore();
        env_mgr.setProperty('HDB_ROOT', root_original);
    });

    describe('Test createSearchTypeFromSearchObject method', ()=>{
        it('test for search all with wildcard search *', ()=>{
            let search_object = new SearchObject('dev', 'dog', 'name', '*', 'id', ['id', 'name']);
             let search_type =test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
             assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.SEARCH_ALL);
        });

        it('test for search all with wildcard search %', ()=>{
            let search_object = new SearchObject('dev', 'dog', 'name', '%', 'id', ['id', 'name']);
            let search_type =test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
            assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.SEARCH_ALL);
        });

        it('test for * search on hash attribute is search_all', ()=>{
            let search_object = new SearchObject('dev', 'dog', 'id', '*', 'id', ['id', 'name']);
            let search_type =test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
            assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.SEARCH_ALL);
        });

        it('test for exact search on hash attribute is batch search by hash', ()=>{
            let search_object = new SearchObject('dev', 'dog', 'id', '1', 'id', ['id', 'name']);
            let search_type =test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
            assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH);
        });

        it('test for exact search on attribute is equals', ()=>{
            let search_object = new SearchObject('dev', 'dog', 'age', '1', 'id', ['id', 'name']);
            let search_type =test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
            assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.EQUALS);
        });

        it('test for * at first and last character is contains', ()=>{
            let search_object = new SearchObject('dev', 'dog', 'name', '*yl*', 'id', ['id', 'name']);
            let search_type =test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
            assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.CONTAINS);
        });

        it('test for % at first and last character is contains', ()=>{
            let search_object = new SearchObject('dev', 'dog', 'name', '%yl%', 'id', ['id', 'name']);
            let search_type =test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
            assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.CONTAINS);
        });

        it('test for * or % at first and last character is contains', ()=>{
            let search_object = new SearchObject('dev', 'dog', 'name', '*yl%', 'id', ['id', 'name']);
            let search_type =test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
            assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.CONTAINS);

            search_object.search_value = '%yl*';
            search_type =test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
            assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.CONTAINS);
        });

        it('test for * or % at first character only is ends with', ()=>{
            let search_object = new SearchObject('dev', 'dog', 'name', '*yl', 'id', ['id', 'name']);
            let search_type =test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
            assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.ENDS_WITH);

            search_object.search_value = '%yl';
            search_type =test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
            assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.ENDS_WITH);
        });

        it('test for * or % at last character only is starts with', ()=>{
            let search_object = new SearchObject('dev', 'dog', 'name', 'Kyl*', 'id', ['id', 'name']);
            let search_type =test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
            assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.STARTS_WITH);

            search_object.search_value = 'Kyl%';
            search_type =test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
            assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.STARTS_WITH);
        });

        it('test for unknown search_type', ()=>{
            let search_object = new SearchObject('dev', 'dog', 'name', 'Ky*le', 'id', ['id', 'name']);
            let search_type =test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], LMDB_ERRORS.UKNOWN_SEARCH_TYPE);
            assert.deepStrictEqual(search_type, undefined);
        });
    });

    describe('test executeSearch method', ()=>{
        let env;
        before(async () => {
            await fs.mkdirp(SYSTEM_SCHEMA_PATH);
            await fs.mkdirp(DEV_SCHEMA_PATH);
            global.lmdb_map = undefined;

            global.hdb_schema = {
                dev: {
                    test: {
                        attributes: [{attribute: 'id'}, {attribute: 'temperature'}, {attribute: 'temperature_str'}, {attribute: 'state'}, {attribute: 'city'}],
                        hash_attribute: 'id',
                        schema: 'dev',
                        name: 'test'
                    }
                },
                system: systemSchema};

            env = await environment_utility.createEnvironment(DEV_SCHEMA_PATH, 'test');
            await environment_utility.createDBI(env, 'id', false);
            await environment_utility.createDBI(env, 'temperature', true, true);
            await environment_utility.createDBI(env, 'temperature_str', true, false);
            await environment_utility.createDBI(env, 'state', true, false);
            await environment_utility.createDBI(env, 'city', true, false);

            write_utility.insertRecords(env, 'id', ['id', 'temperature', 'temperature_str', 'state', 'city'], test_data);
        });

        after(async () => {
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test equals on string', async()=>{

            let expected = [];
            test_data.forEach(data=>{
                if(data.state === 'CO'){
                    expected.push(Object.assign(
                        Object.create(null), data, TIMESTAMP_OBJECT
                    ));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'state', 'CO', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test equals on number', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(parseInt(data.temperature) === 10){
                    expected.push(Object.assign(
                        Object.create(null), data, TIMESTAMP_OBJECT
                    ));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '10', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test equals on hash attribute', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(parseInt(data.id) === 10){
                    expected.push(Object.assign(
                        Object.create(null), data, TIMESTAMP_OBJECT
                    ));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'id', '10', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test contains on string', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.city.includes('bert') === true){
                    expected.push(Object.assign(
                        Object.create(null), data, TIMESTAMP_OBJECT
                    ));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'city', '*bert*', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test contains on number', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature.includes(0)){
                    expected.push(Object.assign(
                        Object.create(null), data, TIMESTAMP_OBJECT
                    ));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '*0*', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test endswith on string', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.city.endsWith('land')){
                    expected.push(Object.assign(
                        Object.create(null), data, TIMESTAMP_OBJECT
                    ));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'city', '*land', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test endswith on number', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature.toString().endsWith('2')){
                    expected.push(Object.assign(
                        Object.create(null), data, TIMESTAMP_OBJECT
                    ));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '%2', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test startswith on string', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.city.startsWith('South')){
                    expected.push(Object.assign(
                        Object.create(null), data, TIMESTAMP_OBJECT
                    ));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'city', 'South*', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test startswith on number', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature.toString().startsWith('10')){
                    expected.push(Object.assign(
                        Object.create(null), data, TIMESTAMP_OBJECT
                    ));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '10%', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test searchall', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                expected.push(Object.assign(
                    Object.create(null), data, TIMESTAMP_OBJECT
                ));
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '*', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test greaterthan', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature > 25){
                    expected.push(Object.assign(
                        Object.create(null), data, TIMESTAMP_OBJECT
                    ));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '25', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object, lmdb_terms.SEARCH_COMPARATORS.GREATER], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test greaterthanequal', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature >= 40){
                    expected.push(Object.assign(
                        Object.create(null), data, TIMESTAMP_OBJECT
                    ));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object, lmdb_terms.SEARCH_COMPARATORS.GREATER_OR_EQ], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test lessthan', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature < 25){
                    expected.push(Object.assign(
                        Object.create(null), data, TIMESTAMP_OBJECT
                    ));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '25', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object, lmdb_terms.SEARCH_COMPARATORS.LESS], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test lessthanequal', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature <= 40){
                    expected.push(Object.assign(
                        Object.create(null), data, TIMESTAMP_OBJECT
                    ));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object, lmdb_terms.SEARCH_COMPARATORS.LESS_OR_EQ], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test between', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature >= 40 && data.temperature <= 66){
                    expected.push(Object.assign(
                        Object.create(null), data, TIMESTAMP_OBJECT
                    ));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*'], '66');
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object, lmdb_terms.SEARCH_COMPARATORS.BETWEEN], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });
    });
});