'use strict';

const assert = require('assert');
const test_utils = require('../../test_utils');
const fs = require('fs-extra');
const path = require('path');
const env_utility = require('../../../utility/lmdb/environmentUtility');
const clean_lmdb_map = require('../../../utility/lmdb/cleanLMDBMap');
const logger = require('../../../utility/logging/harper_logger');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const LMDB_TEST_FOLDER_NAME = 'lmdbTest';
const BASE_TEST_PATH = path.join(test_utils.getMockLMDBPath(), LMDB_TEST_FOLDER_NAME);
const DEV_PATH = path.join(BASE_TEST_PATH, 'dev');
const PROD_PATH = path.join(BASE_TEST_PATH, 'prod');
const BASE_TXN_PATH = path.join(test_utils.getMockLMDBPath(), 'txn');
const DEV_TXN_PATH = path.join(BASE_TXN_PATH, 'dev');
const PROD_TXN_PATH = path.join(BASE_TXN_PATH, 'prod');

const STAT_ATTRIBUTES = [
	'pageSize',
	'treeDepth',
	'treeBranchPageCount',
	'treeLeafPageCount',
	'entryCount',
	'overflowPages',
];
const ENVIRONMENT_CLOSED_ERROR = Error('The environment is already closed.');

describe('test cleanLMDBMap module', () => {
	let logger_error_stub;
	let close_env_stub;
	beforeEach(async () => {
		global.lmdb_map = undefined;
		await fs.remove(test_utils.getMockLMDBPath());
		await fs.mkdirp(DEV_PATH);
		await fs.mkdirp(PROD_PATH);
		await fs.mkdirp(DEV_TXN_PATH);
		await fs.mkdirp(PROD_TXN_PATH);
	});

	afterEach(async () => {
		close_env_stub.resetHistory();
		logger_error_stub.resetHistory();
		global.lmdb_map = undefined;
		await fs.remove(test_utils.getMockLMDBPath());
	});

	before(() => {
		logger_error_stub = sinon.stub(logger, 'error');
		close_env_stub = sandbox.spy(env_utility, 'closeEnvironment');
	});

	after(async () => {
		global.lmdb_map = undefined;
		await fs.remove(test_utils.getMockLMDBPath());
		sinon.restore();
	});

	it('pass no message assert close & logger not called', async () => {
		await clean_lmdb_map();
		assert.deepStrictEqual(logger_error_stub.callCount, 0);
		assert.deepStrictEqual(close_env_stub.callCount, 0);
	});

	it('create environments call drop_schema, verify all environments & their txn environments close for just the defined schema', async () => {
		let dog_env = await env_utility.createEnvironment(DEV_PATH, 'dog');
		let breed_env = await env_utility.createEnvironment(DEV_PATH, 'breed');
		let txn_dog_env = await env_utility.createEnvironment(DEV_TXN_PATH, 'dog', true);
		let txn_breed_env = await env_utility.createEnvironment(DEV_TXN_PATH, 'breed', true);

		let prod_dog_env = await env_utility.createEnvironment(PROD_PATH, 'dog');
		let prod_txn_dog_env = await env_utility.createEnvironment(PROD_TXN_PATH, 'dog', true);

		assert.deepStrictEqual(Object.keys(dog_env.getStats()), STAT_ATTRIBUTES);
		assert.deepStrictEqual(Object.keys(breed_env.getStats()), STAT_ATTRIBUTES);
		assert.deepStrictEqual(Object.keys(txn_dog_env.getStats()), STAT_ATTRIBUTES);
		assert.deepStrictEqual(Object.keys(txn_breed_env.getStats()), STAT_ATTRIBUTES);
		assert.deepStrictEqual(Object.keys(prod_dog_env.getStats()), STAT_ATTRIBUTES);
		assert.deepStrictEqual(Object.keys(prod_txn_dog_env.getStats()), STAT_ATTRIBUTES);

		await clean_lmdb_map({ operation: 'drop_schema', schema: 'dev' });

		assert.deepStrictEqual(logger_error_stub.callCount, 0);
		assert.deepStrictEqual(close_env_stub.callCount, 4);

		assert.throws(() => {
			dog_env.env.stat();
		}, ENVIRONMENT_CLOSED_ERROR);
		assert.throws(() => {
			breed_env.env.stat();
		}, ENVIRONMENT_CLOSED_ERROR);
		assert.throws(() => {
			txn_dog_env.env.stat();
		}, ENVIRONMENT_CLOSED_ERROR);
		assert.throws(() => {
			txn_breed_env.env.stat();
		}, ENVIRONMENT_CLOSED_ERROR);
		assert.deepStrictEqual(Object.keys(prod_dog_env.getStats()), STAT_ATTRIBUTES);
		assert.deepStrictEqual(Object.keys(prod_txn_dog_env.getStats()), STAT_ATTRIBUTES);

		assert.deepStrictEqual(global.lmdb_map['dev.dog'], undefined);
		assert.deepStrictEqual(global.lmdb_map['dev.breed'], undefined);
		assert.deepStrictEqual(global.lmdb_map['txn.dev.dog'], undefined);
		assert.deepStrictEqual(global.lmdb_map['txn.dev.breed'], undefined);
		assert.notDeepStrictEqual(global.lmdb_map['txn.prod.dog'], undefined);
		assert.notDeepStrictEqual(global.lmdb_map['prod.dog'], undefined);

		await prod_dog_env.close();
		await prod_txn_dog_env.close();
	});

	it('create environments call drop_table, verify all environments & their txn environments close for just the defined table', async () => {
		let dog_env = await env_utility.createEnvironment(DEV_PATH, 'dog');
		let breed_env = await env_utility.createEnvironment(DEV_PATH, 'breed');
		let txn_dog_env = await env_utility.createEnvironment(DEV_TXN_PATH, 'dog', true);
		let txn_breed_env = await env_utility.createEnvironment(DEV_TXN_PATH, 'breed', true);

		assert.deepStrictEqual(Object.keys(dog_env.getStats()), STAT_ATTRIBUTES);
		assert.deepStrictEqual(Object.keys(breed_env.getStats()), STAT_ATTRIBUTES);
		assert.deepStrictEqual(Object.keys(txn_dog_env.getStats()), STAT_ATTRIBUTES);
		assert.deepStrictEqual(Object.keys(txn_breed_env.getStats()), STAT_ATTRIBUTES);

		await clean_lmdb_map({ operation: 'drop_table', schema: 'dev', table: 'dog' });

		assert.deepStrictEqual(logger_error_stub.callCount, 0);
		//assert.deepStrictEqual(close_env_stub.callCount, 2);

		assert.throws(() => {
			dog_env.env.stat();
		}, ENVIRONMENT_CLOSED_ERROR);
		assert.throws(() => {
			txn_dog_env.env.stat();
		}, ENVIRONMENT_CLOSED_ERROR);
		assert.deepStrictEqual(Object.keys(breed_env.getStats()), STAT_ATTRIBUTES);
		assert.deepStrictEqual(Object.keys(txn_breed_env.getStats()), STAT_ATTRIBUTES);

		assert.deepStrictEqual(global.lmdb_map['dev.dog'], undefined);
		assert.notDeepStrictEqual(global.lmdb_map['dev.breed'], undefined);
		assert.deepStrictEqual(global.lmdb_map['txn.dev.dog'], undefined);
		assert.notDeepStrictEqual(global.lmdb_map['txn.dev.breed'], undefined);

		await breed_env.close();
		await txn_breed_env.close();
	});

	it('call drop_attribute, verify the dbi is no longer in memory', async () => {
		let dog_env = await env_utility.createEnvironment(DEV_PATH, 'dog');
		env_utility.createDBI(dog_env, 'id', false);
		assert.deepStrictEqual(Object.keys(dog_env.getStats()), STAT_ATTRIBUTES);
		assert.deepStrictEqual(Object.keys(dog_env.dbis).indexOf('id') >= 0, true);
		await clean_lmdb_map({ operation: 'drop_attribute', schema: 'dev', table: 'dog', attribute: 'id' });
		assert.deepStrictEqual(Object.keys(dog_env.dbis).indexOf('id') >= 0, false);
		await dog_env.close();
	});

	it('Confirm env required errors on drop schema are caught and not thrown', async () => {
		let dog_env = await env_utility.createEnvironment(DEV_PATH, 'dog');
		env_utility.createDBI(dog_env, 'id', false);
		close_env_stub.restore();
		close_env_stub = sandbox.stub(env_utility, 'closeEnvironment').throws(new Error('env is required'));
		await clean_lmdb_map({ operation: 'drop_schema', schema: 'dev' });
		assert.deepStrictEqual(logger_error_stub.callCount, 0);
		await dog_env.close();
	});

	it('Confirm error from closeEnvironment drop schema is thrown', async () => {
		let dog_env = await env_utility.createEnvironment(DEV_PATH, 'dog');
		env_utility.createDBI(dog_env, 'id', false);
		close_env_stub.restore();
		close_env_stub = sandbox.stub(env_utility, 'closeEnvironment').throws(new Error('env does not exist'));
		await clean_lmdb_map({ operation: 'drop_schema', schema: 'dev' });
		assert.deepStrictEqual(logger_error_stub.callCount, 1);
		await dog_env.close();
	});

	it('Confirm env required errors on drop table are caught and not thrown', async () => {
		let dog_env = await env_utility.createEnvironment(DEV_PATH, 'dog');
		env_utility.createDBI(dog_env, 'id', false);
		close_env_stub.restore();
		close_env_stub = sandbox.stub(env_utility, 'closeEnvironment').throws(new Error('env is required'));
		await clean_lmdb_map({ operation: 'drop_table', schema: 'dev' });
		close_env_stub.restore();
		assert.deepStrictEqual(logger_error_stub.callCount, 0);
		await dog_env.close();
	});

	it('Confirm error from closeEnvironment drop table is thrown', async () => {
		let dog_env = await env_utility.createEnvironment(DEV_PATH, 'dog');
		env_utility.createDBI(dog_env, 'id', false);
		close_env_stub.restore();
		close_env_stub = sandbox.stub(env_utility, 'closeEnvironment').throws(new Error('env does not exist'));
		await clean_lmdb_map({ operation: 'drop_table', schema: 'dev' });
		close_env_stub.restore();
		assert.deepStrictEqual(logger_error_stub.callCount, 1);
		await dog_env.close();
	});
});
