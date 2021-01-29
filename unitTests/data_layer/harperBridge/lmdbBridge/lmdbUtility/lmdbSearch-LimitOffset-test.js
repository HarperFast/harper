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

let test_data = require('../../../../testData');

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
const common_utils = require('../../../../../utility/common_utils');

const TIMESTAMP = Date.now();

const sandbox = sinon.createSandbox();

const TIMESTAMP_OBJECT = {
    [hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME]: TIMESTAMP,
    [hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME]: TIMESTAMP,
};

const HASH_ATTRIBUTE_NAME = 'id';
const thread_search_function = lmdb_search.__get__('threadSearch');

const ATTRIBUTES = ['id', 'temperature', 'temperature_str', 'state', 'city'];

describe('test lmdbSearch module', ()=>{
    let date_stub;
    before(()=>{
        test_data.forEach(record=>{
            Object.keys(record).forEach(key=>{
                record[key] = common_utils.autoCast(record[key]);
            });
        });
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
    });

    after(()=>{
        date_stub.restore();
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
            await environment_utility.createDBI(env, 'id', false, true);
            await environment_utility.createDBI(env, 'temperature', true);
            await environment_utility.createDBI(env, 'state', true);
            await environment_utility.createDBI(env, 'city', true);

            await write_utility.insertRecords(env, 'id', ['id', 'temperature', 'temperature_str', 'state', 'city'], test_data);
        });

        after(async () => {
            env.close();
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test equals on string limit 20', async()=>{

            let expected = [{"id": 7,"temperature": -3,"temperature_str": -3,"state": "CO","city": "Quitzonside"},{"id": 23,"temperature": 61,"temperature_str": 61,"state": "CO","city": "Kaitlynfort"},{"id": 84,"temperature": -6,"temperature_str": -6,"state": "CO","city": "West Yvonneberg"},{"id": 93,"temperature": 107,"temperature_str": 107,"state": "CO","city": "Jackyland"},{"id": 122,"temperature": 24,"temperature_str": 24,"state": "CO","city": "Adelberthaven"},{"id": 134,"temperature": 24,"temperature_str": 24,"state": "CO","city": "Gilbertstad"},{"id": 144,"temperature": 84,"temperature_str": 84,"state": "CO","city": "McGlynnbury"},{"id": 217,"temperature": 91,"temperature_str": 91,"state": "CO","city": "Chelseyfurt"},{"id": 294,"temperature": 78,"temperature_str": 78,"state": "CO","city": "Thomasshire"},{"id": 375,"temperature": 73,"temperature_str": 73,"state": "CO","city": "Wolfbury"},{"id": 382,"temperature": 46,"temperature_str": 46,"state": "CO","city": "South Katrina"},{"id": 512,"temperature": 78,"temperature_str": 78,"state": "CO","city": "Curtiston"},{"id": 537,"temperature": 32,"temperature_str": 32,"state": "CO","city": "North Danaview"},{"id": 572,"temperature": 3,"temperature_str": 3,"state": "CO","city": "East Cesarfort"},{"id": 622,"temperature": 27,"temperature_str": 27,"state": "CO","city": "Kalimouth"},{"id": 682,"temperature": 24,"temperature_str": 24,"state": "CO","city": "Lake Webster"},{"id": 698,"temperature": 98,"temperature_str": 98,"state": "CO","city": "Lake Cassidy"},{"id": 781,"temperature": 103,"temperature_str": 103,"state": "CO","city": "Port Brooke"},{"id": 809,"temperature": 51,"temperature_str": 51,"state": "CO","city": "Lake Chanceton"},{"id": 855,"temperature": 1,"temperature_str": 1,"state": "CO","city": "Hannahborough"}];

            let search_object = new SearchObject('dev', 'test', 'state', 'CO', 'id', ATTRIBUTES, undefined, false, 20);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepStrictEqual(results.length, 20);
            assert.deepEqual(results, expected);
        });

        it('test equals on string limit 20 offset 20', async()=>{

            let expected = [{"id": 929,"temperature": 105,"temperature_str": 105,"state": "CO","city": "Lake Athena"},{"id": 964,"temperature": 9,"temperature_str": 9,"state": "CO","city": "Meredithshire"},{"id": 998,"temperature": -9,"temperature_str": -9,"state": "CO","city": "North Sally"}];

            let search_object = new SearchObject('dev', 'test', 'state', 'CO', 'id', ATTRIBUTES, undefined, false, 20, 20);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepStrictEqual(results.length, 3);
            assert.deepEqual(results, expected);
        });

        it('test equals on string reverse limit 20 offset 20', async()=>{
            let expected = [{"id": 7,"temperature": -3,"temperature_str": -3,"state": "CO","city": "Quitzonside"},{"id": 23,"temperature": 61,"temperature_str": 61,"state": "CO","city": "Kaitlynfort"},{"id": 84,"temperature": -6,"temperature_str": -6,"state": "CO","city": "West Yvonneberg"}];

            let search_object = new SearchObject('dev', 'test', 'state', 'CO', 'id', ATTRIBUTES, undefined, true, 20, 20);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepStrictEqual(results.length, 3);
            assert.deepEqual(results, expected);
        });

        it('test equals on string return map limit 20', async()=>{

            let expected = {"7": {"id": 7,"temperature": -3,"temperature_str": -3,"state": "CO","city": "Quitzonside"},"23": {"id": 23,"temperature": 61,"temperature_str": 61,"state": "CO","city": "Kaitlynfort"},"84": {"id": 84,"temperature": -6,"temperature_str": -6,"state": "CO","city": "West Yvonneberg"},"93": {"id": 93,"temperature": 107,"temperature_str": 107,"state": "CO","city": "Jackyland"},"122": {"id": 122,"temperature": 24,"temperature_str": 24,"state": "CO","city": "Adelberthaven"},"134": {"id": 134,"temperature": 24,"temperature_str": 24,"state": "CO","city": "Gilbertstad"},"144": {"id": 144,"temperature": 84,"temperature_str": 84,"state": "CO","city": "McGlynnbury"},"217": {"id": 217,"temperature": 91,"temperature_str": 91,"state": "CO","city": "Chelseyfurt"},"294": {"id": 294,"temperature": 78,"temperature_str": 78,"state": "CO","city": "Thomasshire"},"375": {"id": 375,"temperature": 73,"temperature_str": 73,"state": "CO","city": "Wolfbury"},"382": {"id": 382,"temperature": 46,"temperature_str": 46,"state": "CO","city": "South Katrina"},"512": {"id": 512,"temperature": 78,"temperature_str": 78,"state": "CO","city": "Curtiston"},"537": {"id": 537,"temperature": 32,"temperature_str": 32,"state": "CO","city": "North Danaview"},"572": {"id": 572,"temperature": 3,"temperature_str": 3,"state": "CO","city": "East Cesarfort"},"622": {"id": 622,"temperature": 27,"temperature_str": 27,"state": "CO","city": "Kalimouth"},"682": {"id": 682,"temperature": 24,"temperature_str": 24,"state": "CO","city": "Lake Webster"},"698": {"id": 698,"temperature": 98,"temperature_str": 98,"state": "CO","city": "Lake Cassidy"},"781": {"id": 781,"temperature": 103,"temperature_str": 103,"state": "CO","city": "Port Brooke"},"809": {"id": 809,"temperature": 51,"temperature_str": 51,"state": "CO","city": "Lake Chanceton"},"855": {"id": 855,"temperature": 1,"temperature_str": 1,"state": "CO","city": "Hannahborough"}};

            let search_object = new SearchObject('dev', 'test', 'state', 'CO', 'id', ATTRIBUTES, undefined, false, 20);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME, true], undefined);
            assert.deepStrictEqual(Object.keys(results).length, 20);
            assert.deepEqual(results, expected);
        });

        it('test contains on string limit 20', async()=>{
            let expected = [{"id": 107,"temperature": 33,"temperature_str": 33,"state": "DE","city": "Albertville"},{"id": 122,"temperature": 24,"temperature_str": 24,"state": "CO","city": "Adelberthaven"},{"id": 966,"temperature": 38,"temperature_str": 38,"state": "AL","city": "Albertostad"}];

            let search_object = new SearchObject('dev', 'test', 'city', 'bert', 'id', ATTRIBUTES, undefined, false, 20);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, 3);
            assert.deepEqual(results, expected);
        });

        it('test contains on string limit 1 offset 1', async()=>{
            let expected = [{"id": 122,"temperature": 24,"temperature_str": 24,"state": "CO","city": "Adelberthaven"}];

            let search_object = new SearchObject('dev', 'test', 'city', 'bert', 'id', ATTRIBUTES, undefined, false, 1,1);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, 1);
            assert.deepEqual(results, expected);
        });

        it('test  contains on string return map', async()=>{

            let expected = Object.create(null);
            test_data.forEach(data=>{
                if(data.city.includes('bert') === true){
                    expected[data.id] = test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'city', 'bert', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test contains on number', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature.toString().includes(0)){
                    expected.push(test_utils.assignObjecttoNullObject(data));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '0', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test  contains on number return map', async()=>{

            let expected = Object.create(null);
            test_data.forEach(data=>{
                if(data.temperature.toString().includes(0)){
                    expected[data.id] = test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '0', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test endswith on string', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.city.endsWith('land')){
                    expected.push(test_utils.assignObjecttoNullObject(data));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'city', 'land', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.ENDS_WITH, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test  endswith on string return map', async()=>{

            let expected = Object.create(null);
            test_data.forEach(data=>{
                if(data.city.endsWith('land')){
                    expected[data.id] = test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'city', 'land', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.ENDS_WITH, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test endswith on number', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature.toString().endsWith('2')){
                    expected.push(test_utils.assignObjecttoNullObject(data));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '2', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.ENDS_WITH, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test endswith on number return map', async()=>{

            let expected = Object.create(null);
            test_data.forEach(data=>{
                if(data.temperature.toString().endsWith('2')){
                    expected[data.id] = test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '2', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.ENDS_WITH, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test startswith on string', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.city.startsWith('South')){
                    expected.push(test_utils.assignObjecttoNullObject(data));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'city', 'South', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test startswith on string return map', async()=>{

            let expected = Object.create(null);
            test_data.forEach(data=>{
                if(data.city.startsWith('South')){
                    expected[data.id] = test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'city', 'South', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test startswith on number', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature.toString().startsWith('10')){
                    expected.push(test_utils.assignObjecttoNullObject(data));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '10', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test startswith on number return map', async()=>{

            let expected = Object.create(null);
            test_data.forEach(data=>{
                if(data.temperature.toString().startsWith('10')){
                    expected[data.id] = test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '10', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test searchall', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                expected.push(test_utils.assignObjecttoNullObject(data));
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '*', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.SEARCH_ALL, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test searchall to map', async()=>{

            let expected = Object.create(null);
            test_data.forEach(data=>{

                expected[data.id] = test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT);
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '10%', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.SEARCH_ALL_TO_MAP, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test greaterthan', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature > 25){
                    expected.push(test_utils.assignObjecttoNullObject(data));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '25', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test greaterthan to map', async()=>{

            let expected = Object.create(null);
            test_data.forEach(data=>{
                if(data.temperature > 25){
                    expected[data.id] = test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '25', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test greaterthanequal', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature >= 40){
                    expected.push(test_utils.assignObjecttoNullObject(data));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test greaterthanequal to map', async()=>{

            let expected = Object.create(null);
            test_data.forEach(data=>{
                // eslint-disable-next-line no-magic-numbers
                if(data.temperature >= 40){
                    expected[data.id] = test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test lessthan', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                // eslint-disable-next-line no-magic-numbers
                if(data.temperature < 25){
                    expected.push(test_utils.assignObjecttoNullObject(data));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '25', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test lessthan to map', async()=>{

            let expected = Object.create(null);
            test_data.forEach(data=>{
                // eslint-disable-next-line no-magic-numbers
                if(data.temperature < 25){
                    expected[data.id] = test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '25', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test lessthanequal', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                // eslint-disable-next-line no-magic-numbers
                if(data.temperature <= 40){
                    expected.push(test_utils.assignObjecttoNullObject(data));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test lessthanequal to map', async()=>{

            let expected = Object.create(null);
            test_data.forEach(data=>{
                if(data.temperature <= 40){
                    expected[data.id] = test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test between', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature >= 40 && data.temperature <= 66){
                    expected.push(test_utils.assignObjecttoNullObject(data));
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*'], '66');
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.BETWEEN, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test between to map', async()=>{

            let expected = Object.create(null);
            test_data.forEach(data=>{
                if(data.temperature >= 40 && data.temperature <= 66){
                    expected[data.id] = test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*'], '66');
            let results = await test_utils.assertErrorAsync(lmdb_search.executeSearch, [search_object, lmdb_terms.SEARCH_TYPES.BETWEEN, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });
    });

    describe('test threadSearch function', ()=>{
        let env;
        let temp_env;
        let rw_ts_path;
        before(async () => {
            test_data = require('../../../../testData');
            rw_ts_path = lmdb_search.__set__('LMDB_THREAD_SEARCH_MODULE_PATH', path.join(__dirname, '_lmdbThreadSearch'));
            await fs.mkdirp(SYSTEM_SCHEMA_PATH);
            temp_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, 'hdb_temp');
            environment_utility.createDBI(temp_env, 'id', false);

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
            await environment_utility.createDBI(env, 'temperature', true);
            await environment_utility.createDBI(env, 'temperature_double', true);
            await environment_utility.createDBI(env, 'temperature_neg', true);
            await environment_utility.createDBI(env, 'temperature_pos', true);
            await environment_utility.createDBI(env, 'temperature_str', true);
            await environment_utility.createDBI(env, 'state', true);
            await environment_utility.createDBI(env, 'city', true);

            await write_utility.insertRecords(env, 'id', ['id', 'temperature', 'temperature_str', 'state', 'city'], test_data);
        });

        after(async () => {
            env.close();
            temp_env.close();
            rw_ts_path();
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test equals on string', async()=>{

            let expected = [];
            test_data.forEach(data=>{
                if(data.state === 'CO'){
                    expected.push(data);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'state', 'CO', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepEqual(result, expect);
                    }
                });
            });

        });

        it('test equals on string return map', async()=>{

            let expected = Object.create(null);
            test_data.forEach(data=>{
                if(data.state === 'CO'){
                    expected[data.id] = data;
                }
            });

            let search_object = new SearchObject('dev', 'test', 'state', 'CO', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepEqual(results, expected);
        });

        it('test equals on number', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(parseInt(data.temperature) === 10){
                    expected.push(data);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '10', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test equals on number return map', async()=>{

            let expected = {};
            test_data.forEach(data=>{
                if(parseInt(data.temperature) === 10){
                    expected[data.id] = data;
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '10', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test equals on hash attribute', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(parseInt(data.id) === 10){
                    expected.push(data);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'id', '10', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test  equals on hash attribute return map', async()=>{

            let expected = {};
            test_data.forEach(data=>{
                if(parseInt(data.id) === 10){
                    expected[data.id] = data;
                }
            });

            let search_object = new SearchObject('dev', 'test', 'id', '10', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH_TO_MAP, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test contains on string', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.city.includes('bert') === true){
                    expected.push(data);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'city', 'bert', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test  contains on string return map', async()=>{

            let expected = {};
            test_data.forEach(data=>{
                if(data.city.includes('bert') === true){
                    expected[data.id] = data;
                }
            });

            let search_object = new SearchObject('dev', 'test', 'city', 'bert', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test contains on number', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature.toString().includes(0)){
                    expected.push(data);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '0', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test  contains on number return map', async()=>{

            let expected = {};
            test_data.forEach(data=>{
                if(data.temperature.toString().includes(0)){
                    expected[data.id] = data;
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '0', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test endswith on string', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.city.endsWith('land')){
                    expected.push(data);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'city', 'land', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.ENDS_WITH, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test  endswith on string return map', async()=>{

            let expected = {};
            test_data.forEach(data=>{
                if(data.city.endsWith('land')){
                    expected[data.id] = data;
                }
            });

            let search_object = new SearchObject('dev', 'test', 'city', 'land', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.ENDS_WITH, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test endswith on number', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature.toString().endsWith('2')){
                    expected.push(data);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '2', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.ENDS_WITH, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test endswith on number return map', async()=>{

            let expected = {};
            test_data.forEach(data=>{
                if(data.temperature.toString().endsWith('2')){
                    expected[data.id] = data;
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '2', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.ENDS_WITH, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test startswith on string', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.city.startsWith('South')){
                    expected.push(data);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'city', 'South', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test startswith on string return map', async()=>{

            let expected = {};
            test_data.forEach(data=>{
                if(data.city.startsWith('South')){
                    expected[data.id] = data;
                }
            });

            let search_object = new SearchObject('dev', 'test', 'city', 'South', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test startswith on number', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature.toString().startsWith('10')){
                    expected.push(data);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '10', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test startswith on number return map', async()=>{

            let expected = {};
            test_data.forEach(data=>{
                if(data.temperature.toString().startsWith('10')){
                    expected[data.id] = data;
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '10', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test searchall', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                expected.push(data);
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '*', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.SEARCH_ALL, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test searchall to map', async()=>{

            let expected = {};
            test_data.forEach(data=>{
                expected[data.id] = data;
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '10%', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.SEARCH_ALL_TO_MAP, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test greaterthan', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature > 25){
                    expected.push(data);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '25', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test greaterthan to map', async()=>{

            let expected = {};
            test_data.forEach(data=>{
                if(data.temperature > 25){
                    expected[data.id] = data;
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '25', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test greaterthanequal', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature >= 40){
                    expected.push(data);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test greaterthanequal to map', async()=>{

            let expected = {};
            test_data.forEach(data=>{
                if(data.temperature >= 40){
                    expected[data.id] = data;
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test lessthan', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature < 25){
                    expected.push(data);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '25', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test lessthan to map', async()=>{

            let expected = {};
            test_data.forEach(data=>{
                if(data.temperature < 25){
                    expected[data.id] = data;
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '25', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test lessthanequal', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature <= 40){
                    expected.push(data);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test lessthanequal to map', async()=>{

            let expected = {};
            test_data.forEach(data=>{
                if(data.temperature <= 40){
                    expected[data.id] = data;
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*']);
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test between', async()=>{
            let expected = [];
            test_data.forEach(data=>{
                if(data.temperature >= 40 && data.temperature <= 66){
                    expected.push(data);
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*'], '66');
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.BETWEEN, HASH_ATTRIBUTE_NAME], undefined);
            assert.deepEqual(results.length, expected.length);

            results.forEach(result=>{
                expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });

        it('test between to map', async()=>{

            let expected = {};
            test_data.forEach(data=>{
                if(data.temperature >= 40 && data.temperature <= 66){
                    expected[data.id] = data;
                }
            });

            let search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*'], '66');
            let results = await test_utils.assertErrorAsync(thread_search_function, [search_object, lmdb_terms.SEARCH_TYPES.BETWEEN, HASH_ATTRIBUTE_NAME, true], undefined);
            assert(Object.keys(results).length > 0);
            assert.deepStrictEqual(results, expected);
        });

        it('test multiple searches in flight', async()=>{
            let between_search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*'], '66');
            let between_expected = [];
            test_data.forEach(data=>{
                if(data.temperature >= 40 && data.temperature <= 66){
                    between_expected.push(data);
                }
            });

            let less_equal_search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*']);
            let less_equal_expected = [];
            test_data.forEach(data=>{
                if(data.temperature <= 40){
                    less_equal_expected.push(data);
                }
            });

            let less_search_object = new SearchObject('dev', 'test', 'temperature', '25', 'id', ['*']);
            let less_expected = [];
            test_data.forEach(data=>{
                if(data.temperature < 25){
                    less_expected.push(data);
                }
            });

            let greaterequal_search_object = new SearchObject('dev', 'test', 'temperature', '40', 'id', ['*']);
            let greaterequal_expected = [];
            test_data.forEach(data=>{
                if(data.temperature >= 40){
                    greaterequal_expected.push(data);
                }
            });

            let contains_search_object = new SearchObject('dev', 'test', 'city', 'bert', 'id', ['*']);
            let contains_expected = [];
            test_data.forEach(data=>{
                if(data.city.includes('bert') === true){
                    contains_expected.push(data);
                }
            });

            let [between_results, less_equal_results, less_results, greater_equal_results, contains_results] = await Promise.all([
                thread_search_function(between_search_object, lmdb_terms.SEARCH_TYPES.BETWEEN, HASH_ATTRIBUTE_NAME),
                thread_search_function(less_equal_search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL, HASH_ATTRIBUTE_NAME),
                thread_search_function(less_search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN, HASH_ATTRIBUTE_NAME),
                thread_search_function(greaterequal_search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL, HASH_ATTRIBUTE_NAME),
                thread_search_function(contains_search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME)]);

            assert.notDeepStrictEqual(between_results, undefined);
            assert.notDeepStrictEqual(between_results.length, 0);
            between_results.forEach(result=>{
                between_expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

            assert.notDeepStrictEqual(less_equal_results, undefined);
            assert.notDeepStrictEqual(less_equal_results.length, 0);
            less_equal_results.forEach(result=>{
                less_equal_expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

            assert.notDeepStrictEqual(less_results, undefined);
            assert.notDeepStrictEqual(less_results.length, 0);
            less_results.forEach(result=>{
                less_expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

            assert.notDeepStrictEqual(greater_equal_results, undefined);
            assert.notDeepStrictEqual(greater_equal_results.length, 0);
            greater_equal_results.forEach(result=>{
                greaterequal_expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

            assert.notDeepStrictEqual(contains_results, undefined);
            assert.notDeepStrictEqual(contains_results.length, 0);
            contains_results.forEach(result=>{
                contains_expected.forEach(expect=>{
                    if(result.id === expect.id){
                        assert.deepStrictEqual(result, expect);
                    }
                });
            });

        });
    });
});
