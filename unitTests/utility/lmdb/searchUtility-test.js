'use strict';

const search_util = require('../../../utility/lmdb/searchUtility');
const rewire = require('rewire');
const rw_search_util = rewire('../../../utility/lmdb/searchUtility');
const fs = require('fs-extra');
const environment_utility = require('../../../utility/lmdb/environmentUtility');

const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'lmdbTest');
const TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';
const ALL_ATTRIBUTES = ['id', 'name', 'age'];
const ONE_RECORD_ARRAY = [
    {id:1, name:'Kyle', age:'46'}
];

describe('Test searchUtility module', ()=>{
    describe('test getById function', ()=>{
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
    });
});