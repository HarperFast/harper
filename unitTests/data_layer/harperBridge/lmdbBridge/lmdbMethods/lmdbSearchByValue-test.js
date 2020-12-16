'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
const path = require('path');

const SYSTEM_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const BASE_PATH = test_utils.getMockFSPath();
const BASE_SCHEMA_PATH = path.join(BASE_PATH, SCHEMA_NAME);
const SYSTEM_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, SYSTEM_FOLDER_NAME);
const DEV_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, 'dev');

const test_data = require('../../../../testData');

const rewire = require('rewire');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const lmdb_terms = require('../../../../../utility/lmdb/terms');
const write_utility = require('../../../../../utility/lmdb/writeUtility');
const SearchObject = require('../../../../../data_layer/SearchObject');
const lmdb_search = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbSearchByValue');
const hdb_terms = require('../../../../../utility/hdbTerms');
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

describe('test lmdbSearchByValue module', ()=>{
    let date_stub;
    let rw_env_util;
    before(()=>{
        rw_env_util = environment_utility.__set__('MAP_SIZE', 5*1024*1024*1024);
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
    });

    after(()=>{
        rw_env_util();
        date_stub.restore();
    });

    describe('test method', ()=>{
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
            await environment_utility.createDBI(env, 'temperature', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            await environment_utility.createDBI(env, 'temperature_double', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            await environment_utility.createDBI(env, 'temperature_pos', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            await environment_utility.createDBI(env, 'temperature_neg', true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            await environment_utility.createDBI(env, 'temperature_str', true, lmdb_terms.DBI_KEY_TYPES.STRING);
            await environment_utility.createDBI(env, 'state', true, lmdb_terms.DBI_KEY_TYPES.STRING);
            await environment_utility.createDBI(env, 'city', true, lmdb_terms.DBI_KEY_TYPES.STRING);

            write_utility.insertRecords(env, 'id', ['id', 'temperature', 'temperature_str', 'state', 'city'], test_data);
        });

        after(async () => {
            env.close();
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test validation', async()=>{
            await test_utils.assertErrorAsync(lmdb_search, [{}], new Error("Schema can't be blank,Table can't be blank,Search attribute can't be blank,Get attributes can't be blank"));
            await test_utils.assertErrorAsync(lmdb_search, [{schema:'dev'}], new Error("Table can't be blank,Search attribute can't be blank,Get attributes can't be blank"));
            await test_utils.assertErrorAsync(lmdb_search, [{schema:'dev', table:'test'}], new Error("Search attribute can't be blank,Get attributes can't be blank"));
            await test_utils.assertErrorAsync(lmdb_search, [{schema:'dev', table:'test', search_attribute: 'city'}], new Error("Get attributes can't be blank"));
            await test_utils.assertErrorAsync(lmdb_search, [{schema:'dev', table:'test', search_attribute: 'city', search_value: '*'}], new Error("Get attributes can't be blank"));
            await test_utils.assertErrorAsync(lmdb_search, [{schema:'dev/sss', table:'test', search_attribute: 'city', search_value: '*', get_attributes:['*']}], new Error("Schema names cannot include backticks or forward slashes"));
            await test_utils.assertErrorAsync(lmdb_search, [{schema:'dev', table:'test`e`r', search_attribute: 'city', search_value: '*', get_attributes:['*']}], new Error("Table names cannot include backticks or forward slashes"));

            await test_utils.assertErrorAsync(lmdb_search, [{schema:'dev', table:'test', search_attribute: 'city', search_value: '*', get_attributes:['*']}, '$$'], new Error("Value search comparator - $$ - is not valid"));
        });

        it('test equals on string', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.state === 'CO'){
                    expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
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
                    expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
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
                    expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
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
                    expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
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
                if(data.temperature.toString().includes(0)){
                    expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
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
                    expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
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
                    expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
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
                    expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
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
                    expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
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
                expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
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
                    expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '25', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object, hdb_terms.VALUE_SEARCH_COMPARATORS.GREATER], undefined);
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
                    expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object, hdb_terms.VALUE_SEARCH_COMPARATORS.GREATER_OR_EQ], undefined);
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
                    expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '25', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object, hdb_terms.VALUE_SEARCH_COMPARATORS.LESS], undefined);
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
                    expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object, hdb_terms.VALUE_SEARCH_COMPARATORS.LESS_OR_EQ], undefined);
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
                    expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*'], '66');
            let results = await test_utils.assertErrorAsync(lmdb_search, [search_object, hdb_terms.VALUE_SEARCH_COMPARATORS.BETWEEN], undefined);
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
