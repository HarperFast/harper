'use strict';

const search_util = require('../../../utility/lmdb/searchUtility');
const rewire = require('rewire');
const rw_search_util = rewire('../../../utility/lmdb/searchUtility');
const fs = require('fs-extra');
const environment_utility = require('../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../utility/lmdb/writeUtility');
const test_utils = require('../../test_utils');
const path = require('path');

const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'lmdbTest');
const TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';
const ALL_ATTRIBUTES = ['id', 'name', 'age'];
const ONE_RECORD_ARRAY = [
    {id:1, name:'Kyle', age:46}
];

const MULTI_RECORD_ARRAY = [
    {id:2, name:'Jerry', age:32},
    {id:3, name: 'Hank', age: 57},
    {id:4, name:'Francene', age: 29}
];

const ENV_REQUIRED_ERROR = new Error('env is required');
const INVALID_ENVIRONMENT_ERROR = new Error('invalid environment object');
const FETCH_ATTRIBUTES_REQUIRED_ERROR = new Error('fetch_attributes is required');
const FETCH_ATTRIBUTES_NOT_ARRAY_ERROR = new Error('fetch_attributes must be an array');
const HASH_ATTRIBUTE_REQUIRED_ERROR = new Error('hash_attribute is required');
const ID_REQUIRED_ERROR = new Error('id is required');

describe('Test searchUtility module', ()=>{
    describe('test getById function', ()=>{
        let env;
        before(async ()=>{
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            await environment_utility.createDBI(env, 'id');
            write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, MULTI_RECORD_ARRAY);
        });

        after(async ()=>{
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it("test validation", ()=>{
            test_utils.assertErrorSync(search_util.getById, [], ENV_REQUIRED_ERROR);
        });
    });
});