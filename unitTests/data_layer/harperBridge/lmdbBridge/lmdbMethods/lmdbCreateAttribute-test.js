'use strict';

const assert = require('assert');
const rewire = require('rewire');
const lmdb_create_schema = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const lmdb_create_table = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const environment_utility = require('../../../../../utility/lmdb/environmentUtility');
const search_utility = require('../../../../../utility/lmdb/searchUtility');
const systemSchema = require('../../../../../json/systemSchema');
const test_utils = require('../../../../test_utils');
const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const sinon = require('sinon');
const env_mgr = require('../../../../../utility/environment/environmentManager');
if(!env_mgr.isInitialized()){
    env_mgr.initSync();
}

const sandbox = sinon.createSandbox();
const TIMESTAMP = Date.now();


const LMDB_TEST_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const BASE_PATH = test_utils.getMockFSPath();
const BASE_SCHEMA_PATH = path.join(BASE_PATH, SCHEMA_NAME);
const BASE_TEST_PATH = path.join(BASE_SCHEMA_PATH, LMDB_TEST_FOLDER_NAME);
const TEST_ENVIRONMENT_NAME = 'hdb_schema';
const HASH_ATTRIBUTE_NAME = 'name';