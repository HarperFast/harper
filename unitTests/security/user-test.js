'use strict';
const test_utils = require('../test_utils');
test_utils.preTestPrep();
const assert = require('assert');
const sinon = require('sinon');
const chai = require('chai');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);
const rewire = require('rewire');
const crypto_hash = require('../../security/cryptoHash');
const user = rewire('../../security/user');
const insert = require('../../dataLayer/insert');
const validation = require('../../validation/user_validation');
const signalling = require('../../utility/signalling');
const logger = require('../../utility/logging/harper_logger');
const env_manager = require('../../utility/environment/environmentManager');
const config_utils = require('../../config/configUtils');
let license = require('../../utility/registration/hdb_license');
const { TEST_USER_ERROR_MSGS } = require('../commonTestErrors');

let USER_SEARCH_RESULT = new Map([
	[
		'cluster_user',
		{
			active: true,
			hash: 'blahbblah',
			password: 'somepass',
			role: {
				id: '58aa0e11-b761-4ade-8a7d-e90f1d99d246',
				permission: {
					cluster_user: true,
				},
				role: 'cluster_user',
			},
			username: 'cluster_user',
		},
	],
	[
		'su_1',
		{
			active: true,
			password: 'somepass',
			role: {
				id: '08fec166-bbfb-4822-ab3d-9cb4baeff86f',
				permission: {
					super_user: true,
				},
				role: 'super_user',
			},
			username: 'su_1',
		},
	],
	[
		'su_2',
		{
			active: true,
			password: 'somepass',
			role: {
				id: '08fec166-bbfb-4822-ab3d-9cb4baeff86f',
				permission: {
					super_user: true,
				},
				role: 'super_user',
			},
			username: 'su_2',
		},
	],
	[
		'nonsu_1',
		{
			active: true,
			password: 'somepass',
			role: {
				id: '123a0e11-b761-4ade-8a7d-e90f1d99d246',
				permission: {
					super_user: false,
				},
				role: 'nonsu_role',
			},
			username: 'nonsu_1',
		},
	],
]);

const TEST_USER = {
	active: true,
	username: 'test_user',
	role: {
		id: '08fec166-bbfb-4822-ab3d-9cb4baeff86f',
		permission: {
			super_user: true,
		},
		role: 'super_user',
	},
};

const TEST_ADD_USER_JSON = {
	operation: 'add_user',
	role: 'test_role',
	username: 'test_user',
	password: 'test1234!',
	active: 'true',
};

const TEST_ALTER_USER_JSON = {
	operation: 'alter_user',
	role: 'test_role',
	username: 'test_user',
	password: 'test1234!',
};

const TEST_ALTER_USER_NO_USERNAME_JSON = {
	operation: 'alter_user',
	role: '057540eb-3e93-4fab-8397-a4545f850b18',
	password: 'test1234!',
};

const TEST_ALTER_USER_NOTHING_TO_UPDATE_JSON = {
	operation: 'alter_user',
	username: 'test_user',
};

const TEST_ALTER_USER_NOTHING_TO_UPDATE_JSON2 = {
	operation: 'alter_user',
	username: 'test_user',
	role: '',
	password: '',
};

const TEST_ALTER_USER_EMPTY_ROLE_JSON = {
	operation: 'alter_user',
	username: 'test_user',
	active: true,
	role: '',
};

const TEST_ALTER_USER_EMPTY_PASSWORD_JSON = {
	operation: 'alter_user',
	username: 'test_user',
	active: true,
	password: '',
};

const TEST_ALTER_USER_ACTIVE_NOT_BOOLEAN_JSON = {
	operation: 'alter_user',
	username: 'test_user',
	active: 'stuff',
};

const TEST_DROP_USER_JSON = {
	operation: 'drop_user',
	username: 'test_user',
};

const TEST_ADD_USER_SEARCH_OBJ = [
	{
		schema: 'system',
		table: 'hdb_role',
		search_attribute: 'role',
		search_value: 'super_user',
		get_attributes: ['id', 'role', 'permission'],
	},
];

const TEST_USER_INFO_JSON = {
	operation: 'user_info',
	hdb_user: {
		active: true,
		role: {
			id: 'dc52dc65-efc7-4cc4-b3ed-04a98602c0b2',
			permission: {
				super_user: true,
			},
			role: 'super_user',
		},
		username: 'blah',
	},
};

const TEST_USER_INFO_SEARCH_RESPONSE = [
	{
		permission: {
			super_user: true,
		},
		role: 'super_user',
		id: 'dc52dc65-efc7-4cc4-b3ed-04a98602c0b2',
	},
];

const TEST_LIST_USER_JSON = {
	operation: 'list_users',
};

const TEST_LIST_USER_ROLE_SEARCH_RESPONSE = {
	id: '9c9aae33-4d1d-40b5-a52e-bbbc1b2e2ba6',
	permission: {
		super_user: false,
	},
	role: 'some_role',
};

const TEST_LIST_USER_SEARCH_RESPONSE = {
	active: true,
	password: 'tester',
	role: '9c9aae33-4d1d-40b5-a52e-bbbc1b2e2ba6',
	username: 'bad_user',
};

const TEST_UPDATE_RESPONSE = {
	message: `updated 1 of 1 records`,
	update_hashes: '[test_user]',
	skipped_hashes: '[]',
};

const VALID_ROLE = {
	permission: {
		super_user: true,
	},
	id: 'c7035e09-5f5b-43b1-8ba9-c945f8c9da35',
	role: 'super_user',
};

const TEST_USER_INFO_SEARCH_FAIL_RESPONSE = 'Role Not Found';

const ADD_USER_RESULT = 'test_user successfully added';
const BAD_ROLE_SEARCH_RESULT = '057540eb-3e93-4fab-8397-a4545f850b18 role not found';
const ADD_USER_INSERT_FAILED_RESULT = 'Insert Failed.';
const FAILED_VALIDATE_MESSAGE = 'Failed Validation';
const DROP_USER_RESULT = 'test_user successfully deleted';
const USER_SEARCH_FAILED_RESULT = 'User not found';

// Naive clone, never ever do this in prod code.
function clone(a) {
	return JSON.parse(JSON.stringify(a));
}

let search_hash_stub = undefined;
let search_value_stub = undefined;
let search_val_orig = user.__get__('p_search_search_by_value');
let insert_stub = undefined;
let update_stub = undefined;
let validate_stub = undefined;
let signal_spy = undefined;
let search_orig = user.__get__('p_search_search_by_hash');

describe('Test user.js', () => {
	const sandbox = sinon.createSandbox();
	let crypto_stub;

	before(() => {
		crypto_stub = sandbox.stub(crypto_hash, 'encrypt');
	});

	after(() => {
		sandbox.restore();
	});

	describe('Test addUser', function () {
		beforeEach(function () {
			// We are not testing these other functions, so we stub them.
			//search_stub = sinon.stub(search, "searchByHash").yields("", TEST_ADD_USER_SEARCH_OBJ);
			search_hash_stub = sinon.stub().resolves(TEST_USER_INFO_SEARCH_RESPONSE);
			search_value_stub = sinon.stub().resolves(TEST_USER_INFO_SEARCH_RESPONSE);
			user.__set__('p_search_search_by_hash', search_hash_stub);
			user.__set__('p_search_search_by_value', search_value_stub);
			insert_stub = sinon
				.stub(insert, 'insert')
				.resolves({ message: 'inserted 1 or 1 records', skipped_hashes: [], inserted_hashes: [`test_user`] });
			validate_stub = sinon.stub(validation, 'addUserValidation').callsFake(function () {
				return null;
			});
			signal_spy = sinon.spy(signalling, 'signalUserChange');
		});
		afterEach(function () {
			insert_stub.restore();
			validate_stub.restore();
			signal_spy.restore();
			user.__set__('p_search_search_by_hash', search_orig);
		});

		it('Nominal path, add a user', async function () {
			let res = await user.addUser(TEST_ADD_USER_JSON);
			assert.equal(res, ADD_USER_RESULT, 'Expected success result not returned.');
			assert.equal(signal_spy.called, true);
		});

		it('Nominal path, add a cluster_user', async function () {
			let search_resp_copy = test_utils.deepClone(TEST_USER_INFO_SEARCH_RESPONSE);
			search_resp_copy[0].permission.cluster_user = true;
			search_value_stub.resolves(search_resp_copy);
			let res = await user.addUser(TEST_ADD_USER_JSON);

			expect(crypto_stub).to.have.been.calledWith('test1234!');
			assert.equal(res, ADD_USER_RESULT, 'Expected success result not returned.');
			assert.equal(signal_spy.called, true);
		});

		it('Nominal path, user role updated with id value before being passed to insert', async function () {
			await user.addUser(TEST_ADD_USER_JSON);

			let cleaned_user_role = insert_stub.args[0][0].records[0].role;
			let expected_role_id = TEST_USER_INFO_SEARCH_RESPONSE[0].id;
			assert.equal(cleaned_user_role, expected_role_id, 'Expected role value to be updated with id.');
		});

		it('Test error thrown if no role exists', async function () {
			search_value_stub.resolves(null);
			let err = undefined;
			try {
				await user.addUser(TEST_ADD_USER_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(
				err.message,
				TEST_USER_ERROR_MSGS.ROLE_NAME_NOT_FOUND(TEST_ADD_USER_JSON.role),
				'Expected success result not returned.'
			);
			assert.equal(signal_spy.called, false);
		});

		it('Test error thrown if no role exists', async function () {
			search_value_stub.resolves([]);
			let err = undefined;
			try {
				await user.addUser(TEST_ADD_USER_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(
				err.message,
				TEST_USER_ERROR_MSGS.ROLE_NAME_NOT_FOUND(TEST_ADD_USER_JSON.role),
				'Expected success result not returned.'
			);
			assert.equal(signal_spy.called, false);
		});

		it('Test error thrown if more than 1 of same role exists', async function () {
			search_value_stub.resolves([{}, {}]);
			let err = undefined;
			try {
				await user.addUser(TEST_ADD_USER_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(
				err.message,
				TEST_USER_ERROR_MSGS.DUP_ROLES_FOUND(TEST_ADD_USER_JSON.role),
				'Expected success result not returned.'
			);
			assert.equal(signal_spy.called, false);
		});

		it('Test failed insert', async function () {
			// inject a failed insert
			insert_stub.throws(new Error(ADD_USER_INSERT_FAILED_RESULT));
			let err = undefined;
			try {
				let res = await user.addUser(TEST_ADD_USER_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(err.message, ADD_USER_INSERT_FAILED_RESULT, 'Expected success result not returned.');
			assert.equal(signal_spy.called, false);
		});

		it('Test user exists error is thrown', async () => {
			insert_stub.resolves({ skipped_hashes: ['123abc'] });

			const expected_err = test_utils.generateHDBError('User test_user already exists', 409);
			await test_utils.assertErrorAsync(user.addUser, [TEST_ADD_USER_JSON], expected_err);
		});

		it('Test error is logged and thrown from search by value', async () => {
			search_value_stub.throws(new Error('Ugh, an error'));
			let logger_error_stub = sandbox.stub(logger, 'error');
			await test_utils.assertErrorAsync(user.addUser, [TEST_ADD_USER_JSON], new Error('Ugh, an error'));
			expect(logger_error_stub).to.have.been.calledWith('There was an error searching for a role in add user');
			logger_error_stub.restore();
		});

		it('Test error is logged and thrown insert.insert', async () => {
			insert_stub.throws(new Error('Ugh, an error inserting'));
			let logger_error_stub = sandbox.stub(logger, 'error');
			await test_utils.assertErrorAsync(user.addUser, [TEST_ADD_USER_JSON], new Error('Ugh, an error inserting'));
			expect(logger_error_stub).to.have.been.calledWith('There was an error searching for a user.');
			logger_error_stub.restore();
		});

		it('Test error is logged and thrown setUsersToGlobal', async () => {
			const set_users_to_global_stub = sandbox.stub().throws(new Error('Ugh, an error setting users'));
			const set_users_to_global_rw = user.__set__('setUsersToGlobal', set_users_to_global_stub);
			let logger_error_stub = sandbox.stub(logger, 'error');
			await test_utils.assertErrorAsync(user.addUser, [TEST_ADD_USER_JSON], new Error('Ugh, an error setting users'));
			expect(logger_error_stub).to.have.been.calledWith('Got an error setting users to global');
			logger_error_stub.restore();
			set_users_to_global_rw();
		});
	});

	describe('Test alterUser', function () {
		let insert_stub = undefined;
		let role_search_stub = undefined;
		let validate_stub = undefined;
		let signal_spy = undefined;
		let search_orig = user.__get__('p_search_search_by_hash');
		let is_cluster_user_stub = sandbox.stub().returns(false);
		let is_cluster_user_rw;

		before(() => {
			is_cluster_user_rw = user.__set__('isClusterUser', is_cluster_user_stub);
		});

		after(() => {
			is_cluster_user_rw();
		});

		beforeEach(function () {
			update_stub = sinon.stub(insert, 'update').resolves(TEST_UPDATE_RESPONSE);
			validate_stub = sinon.stub(validation, 'alterUserValidation').callsFake(function () {
				return null;
			});
			signal_spy = sinon.spy(signalling, 'signalUserChange');
			role_search_stub = sinon.stub().resolves([TEST_LIST_USER_ROLE_SEARCH_RESPONSE]);
			user.__set__('p_search_search_by_value', role_search_stub);
			global.hdb_users = new Map([[TEST_USER.username, TEST_USER]]);
		});
		afterEach(function () {
			update_stub.restore();
			validate_stub.restore();
			signal_spy.restore();
			global.hdb_users = undefined;
		});
		it('Nominal path, alter a user', async function () {
			// We are not testing these other functions, so we stub them.
			let res = await user.alterUser(TEST_ALTER_USER_JSON);
			assert.equal(res, TEST_UPDATE_RESPONSE, 'Expected success result not returned.');
			assert.equal(signal_spy.called, true);
		});

		it('Nominal path, user role updated with id value before being passed to update', async function () {
			await user.alterUser(TEST_ALTER_USER_JSON);

			let cleaned_user_role = update_stub.args[0][0].records[0].role;
			let expected_role_id = TEST_LIST_USER_ROLE_SEARCH_RESPONSE.id;
			assert.equal(cleaned_user_role, expected_role_id, 'Expected role value to be updated with id.');
		});

		it('Test failed validation no username', async function () {
			// inject a failed insert
			validate_stub.callsFake(function () {
				return FAILED_VALIDATE_MESSAGE;
			});
			let err = undefined;
			try {
				let res = await user.alterUser(TEST_ALTER_USER_NO_USERNAME_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(err.message, user.USERNAME_REQUIRED, 'Expected success result not returned.');
			assert.equal(signal_spy.called, false);
		});

		it('Test failed validation nothing to update', async function () {
			// inject a failed insert
			validate_stub.callsFake(function () {
				return FAILED_VALIDATE_MESSAGE;
			});
			let err = undefined;
			try {
				let res = await user.alterUser(TEST_ALTER_USER_NOTHING_TO_UPDATE_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(err.message, user.ALTERUSER_NOTHING_TO_UPDATE, 'Expected success result not returned.');
			assert.equal(signal_spy.called, false);
		});

		it('Test failed validation nothing to update 2', async function () {
			// inject a failed insert
			validate_stub.callsFake(function () {
				return FAILED_VALIDATE_MESSAGE;
			});
			let err = undefined;
			try {
				let res = await user.alterUser(TEST_ALTER_USER_NOTHING_TO_UPDATE_JSON2);
			} catch (error) {
				err = error;
			}
			assert.equal(err.message, user.ALTERUSER_NOTHING_TO_UPDATE, 'Expected success result not returned.');
			assert.equal(signal_spy.called, false);
		});

		it('Test failed validation empty role', async function () {
			// inject a failed insert
			validate_stub.callsFake(function () {
				return FAILED_VALIDATE_MESSAGE;
			});
			let err = undefined;
			try {
				let res = await user.alterUser(TEST_ALTER_USER_EMPTY_ROLE_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(err.message, user.EMPTY_ROLE, 'Expected success result not returned.');
			assert.equal(signal_spy.called, false);
		});

		it('Test failed validation empty password', async function () {
			// inject a failed insert
			validate_stub.callsFake(function () {
				return FAILED_VALIDATE_MESSAGE;
			});
			let err = undefined;
			try {
				let res = await user.alterUser(TEST_ALTER_USER_EMPTY_PASSWORD_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(err.message, user.EMPTY_PASSWORD, 'Expected success result not returned.');
			assert.equal(signal_spy.called, false);
		});

		it('Test failed validation active not boolean', async function () {
			// inject a failed insert
			validate_stub.callsFake(function () {
				return FAILED_VALIDATE_MESSAGE;
			});
			let err = undefined;
			try {
				let res = await user.alterUser(TEST_ALTER_USER_ACTIVE_NOT_BOOLEAN_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(err.message, user.ACTIVE_BOOLEAN, 'Expected success result not returned.');
			assert.equal(signal_spy.called, false);
		});

		it('Test null role found', async function () {
			role_search_stub = sinon.stub().resolves(null);
			user.__set__('p_search_search_by_value', role_search_stub);
			let err = undefined;
			try {
				await user.alterUser(TEST_ALTER_USER_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(
				err.message,
				TEST_USER_ERROR_MSGS.ALTER_USER_ROLE_NOT_FOUND(TEST_ALTER_USER_JSON.role),
				'Expected success result not returned.'
			);
			assert.equal(signal_spy.called, false);
		});

		it('Test no role found', async function () {
			role_search_stub = sinon.stub().resolves([]);
			user.__set__('p_search_search_by_value', role_search_stub);
			let err = undefined;
			try {
				await user.alterUser(TEST_ALTER_USER_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(
				err.message,
				TEST_USER_ERROR_MSGS.ALTER_USER_ROLE_NOT_FOUND(TEST_ALTER_USER_JSON.role),
				'Expected success result not returned.'
			);
			assert.equal(signal_spy.called, false);
		});

		it('Test multiple roles found', async function () {
			role_search_stub = sinon.stub().resolves([{}, {}]);
			user.__set__('p_search_search_by_value', role_search_stub);
			let err = undefined;
			try {
				await user.alterUser(TEST_ALTER_USER_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(
				err.message,
				TEST_USER_ERROR_MSGS.ALTER_USER_DUP_ROLES(TEST_ALTER_USER_JSON.role),
				'Expected success result not returned.'
			);
			assert.equal(signal_spy.called, false);
		});

		it('Test exception during role search', async function () {
			role_search_stub = sinon.stub().throws(new Error('Role Search Error'));
			user.__set__('p_search_search_by_value', role_search_stub);
			let err = undefined;
			try {
				let res = await user.alterUser(TEST_ALTER_USER_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(err.message, 'Role Search Error', 'Expected success result not returned.');
			assert.equal(signal_spy.called, false);
		});

		it('Test error is logged and thrown from search by value alter user', async () => {
			role_search_stub.throws(new Error('Ugh, an error'));
			let logger_error_stub = sandbox.stub(logger, 'error');
			await test_utils.assertErrorAsync(user.alterUser, [TEST_ALTER_USER_JSON], new Error('Ugh, an error'));
			expect(logger_error_stub).to.have.been.calledWith('Got an error searching for a role.');
			logger_error_stub.restore();
		});

		it('Test error is logged and thrown insert.update', async () => {
			update_stub.throws(new Error('Ugh, an error updating'));
			let logger_error_stub = sandbox.stub(logger, 'error');
			await test_utils.assertErrorAsync(user.alterUser, [TEST_ALTER_USER_JSON], new Error('Ugh, an error updating'));
			expect(logger_error_stub).to.have.been.calledWith('Error during update.');
			logger_error_stub.restore();
		});

		it('Test error is logged and thrown setUsersToGlobal alter user', async () => {
			const set_users_to_global_stub = sandbox.stub().throws(new Error('Ugh, an error setting users'));
			const set_users_to_global_rw = user.__set__('setUsersToGlobal', set_users_to_global_stub);
			let logger_error_stub = sandbox.stub(logger, 'error');
			await test_utils.assertErrorAsync(
				user.alterUser,
				[TEST_ALTER_USER_JSON],
				new Error('Ugh, an error setting users')
			);
			expect(logger_error_stub).to.have.been.calledWith('Got an error setting users to global');
			logger_error_stub.restore();
			set_users_to_global_rw();
		});
	});

	describe('Test dropUser', function () {
		let delete_stub = undefined;
		let validate_stub = undefined;
		let signal_spy = undefined;
		let delete_orig = user.__get__('p_delete_delete');

		before(function () {
			user.__set__('p_search_search_by_value', search_val_orig);
		});

		beforeEach(function () {
			global.hdb_users = new Map([[TEST_USER.username, TEST_USER]]);
			// We are not testing these other functions, so we stub them.
			delete_stub = sinon.stub().resolves(true);
			user.__set__('p_delete_delete', delete_stub);
			validate_stub = sinon.stub(validation, 'dropUserValidation').callsFake(function () {
				return null;
			});
			signal_spy = sinon.spy(signalling, 'signalUserChange');
		});

		afterEach(function () {
			validate_stub.restore();
			signal_spy.restore();
			user.__set__('p_delete_delete', delete_orig);
		});

		it('Nominal path, drop a user', async function () {
			const set_users_to_global_stub = sandbox.stub().resolves();
			const set_users_to_global_rw = user.__set__('setUsersToGlobal', set_users_to_global_stub);
			// We are not testing these other functions, so we stub them.
			let err = undefined;
			let res;
			try {
				res = await user.dropUser(TEST_DROP_USER_JSON);
			} catch (error) {
				err = error;
			}

			set_users_to_global_rw();
			assert.equal(res, DROP_USER_RESULT, 'Expected success result not returned.');
			assert.equal(signal_spy.called, true);
		});

		it('Test failed validation', async function () {
			// inject a failed insert
			validate_stub.callsFake(function () {
				return FAILED_VALIDATE_MESSAGE;
			});
			let err = undefined;
			try {
				let res = await user.dropUser(TEST_ALTER_USER_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(err.message, FAILED_VALIDATE_MESSAGE, 'Expected success result not returned.');
			assert.equal(signal_spy.called, false);
		});

		it('Test error is logged and thrown delete.delete', async () => {
			delete_stub.throws(new Error('Ugh, an error deleting'));
			let logger_error_stub = sandbox.stub(logger, 'error');
			await test_utils.assertErrorAsync(user.dropUser, [TEST_DROP_USER_JSON], new Error('Ugh, an error deleting'));
			expect(logger_error_stub).to.have.been.calledWith('Got an error deleting a user.');
			logger_error_stub.restore();
		});

		it('Test error is logged and thrown setUsersToGlobal drop user', async () => {
			const set_users_to_global_stub = sandbox.stub().throws(new Error('Ugh, an error setting users'));
			const set_users_to_global_rw = user.__set__('setUsersToGlobal', set_users_to_global_stub);
			let logger_error_stub = sandbox.stub(logger, 'error');
			await test_utils.assertErrorAsync(user.dropUser, [TEST_DROP_USER_JSON], new Error('Ugh, an error setting users'));
			expect(logger_error_stub).to.have.been.calledWith('Got an error setting users to global.');
			logger_error_stub.restore();
			set_users_to_global_rw();
		});

		it('Test user does not exist error is thrown', async () => {
			const user_clone = test_utils.deepClone(TEST_DROP_USER_JSON);
			user_clone.username = 'not_a_user';
			const expected_err = test_utils.generateHDBError('User not_a_user does not exist', 404);
			await test_utils.assertErrorAsync(user.dropUser, [user_clone], expected_err);
		});
	});

	describe('Test user_info', function () {
		let search_stub = undefined;
		let search_orig = user.__get__('p_search_search_by_hash');

		beforeEach(function () {
			// We are not testing these other functions, so we stub them.
			search_stub = sinon.stub().resolves(TEST_USER_INFO_SEARCH_RESPONSE);
			user.__set__('p_search_search_by_hash', search_stub);
		});

		afterEach(function () {
			user.__set__('p_search_search_by_hash', search_orig);
		});

		it('Nominal path, get user info', async function () {
			// We are not testing these other functions, so we stub them.
			let err = undefined;
			let res;
			try {
				res = await user.userInfo(TEST_USER_INFO_JSON);
			} catch (error) {
				err = error;
			}
			assert.ok(res.role !== undefined);
			assert.equal(res.role.role, TEST_USER_INFO_SEARCH_RESPONSE[0].role);
			assert.equal(res.role.id, TEST_USER_INFO_SEARCH_RESPONSE[0].id);
			assert.equal(res.role.permission.super_user, TEST_USER_INFO_SEARCH_RESPONSE[0].permission.super_user);
			assert.ok(res.username === 'blah');
			assert.ok(res.password === undefined);
		});

		it('bad search result in user info', async function () {
			// We are not testing these other functions, so we stub them.
			search_stub.throws(new Error(TEST_USER_INFO_SEARCH_FAIL_RESPONSE));
			let err = undefined;
			try {
				let res = await user.userInfo(TEST_USER_INFO_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(err.message, TEST_USER_INFO_SEARCH_FAIL_RESPONSE, 'Expected success result not returned.');
		});

		it('Test no user info message is returned', async () => {
			const result = await user.userInfo({});
			assert.equal(result, 'There was no user info in the body');
		});

		it('Test error is logged and thrown from search by hash user info', async () => {
			search_stub.throws(new Error('Ugh, an error'));
			let logger_error_stub = sandbox.stub(logger, 'error');
			await test_utils.assertErrorAsync(user.userInfo, [TEST_USER_INFO_JSON], new Error('Ugh, an error'));
			expect(logger_error_stub).to.have.been.calledWith('Got an error searching for a role.');
			logger_error_stub.restore();
		});
	});

	describe('Test list_users', function () {
		let search_stub = undefined;
		let search_orig = user.__get__('p_search_search_by_value');
		let license_stub = undefined;
		let sandbox = undefined;

		beforeEach(function () {
			// reset search_stub just in case.
			search_stub = undefined;
			// We are not testing these other functions, so we stub them.
			// Need to clone these since the list_users function attaches the role into the user.
			let role_search_response_clone = clone(TEST_LIST_USER_ROLE_SEARCH_RESPONSE);
			let user_search_response_clone = clone(TEST_LIST_USER_SEARCH_RESPONSE);

			search_stub = sinon.stub().onFirstCall().resolves([role_search_response_clone]);
			search_stub.onSecondCall().resolves([user_search_response_clone]);
			user.__set__('p_search_search_by_value', search_stub);
			sandbox = sinon.createSandbox();
			license_stub = sandbox.stub(license, 'getLicense').resolves({ enterprise: true });
		});

		afterEach(function () {
			user.__set__('p_search_search_by_value', search_orig);
			sandbox.restore();
		});

		it('Nominal path, list users', async function () {
			let err = undefined;
			let res;
			try {
				res = await user.listUsers(TEST_LIST_USER_JSON);
			} catch (error) {
				let err = error;
			}
			const usernames = Array.from(res.keys());
			assert.ok(res.get(usernames[0]).role !== undefined);
			assert.equal(res.get(usernames[0]).role.role, TEST_LIST_USER_ROLE_SEARCH_RESPONSE.role);
			assert.equal(res.get(usernames[0]).username, TEST_LIST_USER_SEARCH_RESPONSE.username);
		});

		it('bad role search result', async function () {
			search_stub = sinon.stub();
			search_stub.throws(new Error(BAD_ROLE_SEARCH_RESULT));
			user.__set__('p_search_search_by_value', search_stub);
			let err = undefined;
			let res;
			try {
				res = await user.listUsers(TEST_LIST_USER_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(err.message, BAD_ROLE_SEARCH_RESULT);
		});

		it('bad user search result', async function () {
			search_stub.onSecondCall().throws(new Error(USER_SEARCH_FAILED_RESULT));
			let err = undefined;
			let res;
			try {
				res = await user.listUsers(TEST_LIST_USER_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(err.message, USER_SEARCH_FAILED_RESULT);
		});

		it('Test error is logged and thrown from search by value roles list users', async () => {
			search_stub.onFirstCall().throws(new Error('Ugh, an error'));
			let logger_error_stub = sandbox.stub(logger, 'error');
			await test_utils.assertErrorAsync(user.listUsers, [TEST_LIST_USER_JSON], new Error('Ugh, an error'));
			expect(logger_error_stub).to.have.been.calledWith('Got an error searching for roles.');
			logger_error_stub.restore();
		});

		it('Test error is logged and thrown from search by value users list users', async () => {
			search_stub.onSecondCall().throws(new Error('Ugh, an error'));
			let logger_error_stub = sandbox.stub(logger, 'error');
			await test_utils.assertErrorAsync(user.listUsers, [TEST_LIST_USER_JSON], new Error('Ugh, an error'));
			expect(logger_error_stub).to.have.been.calledWith('Got an error searching for users.');
			logger_error_stub.restore();
		});

		it('Test null is returned if no roles', async () => {
			search_stub.onFirstCall().resolves([]);
			const result = await user.listUsers(TEST_LIST_USER_JSON);
			assert.equal(result, null);
		});
	});

	describe('Test listUsersExternal', function () {
		let search_stub = undefined;
		let search_orig = user.__get__('p_search_search_by_value');
		let license_stub = undefined;
		let sandbox = undefined;

		beforeEach(function () {
			// reset search_stub just in case.
			search_stub = undefined;
			// We are not testing these other functions, so we stub them.
			// Need to clone these since the list_users function attaches the role into the user.
			let role_search_response_clone = clone(TEST_LIST_USER_ROLE_SEARCH_RESPONSE);
			let user_search_response_clone = clone(TEST_LIST_USER_SEARCH_RESPONSE);
			search_stub = sinon.stub().onFirstCall().resolves([role_search_response_clone]);
			search_stub.onSecondCall().resolves([user_search_response_clone]);
			user.__set__('p_search_search_by_value', search_stub);
			sandbox = sinon.createSandbox();
			license_stub = sandbox.stub(license, 'getLicense').resolves({ enterprise: true });
		});

		afterEach(function () {
			user.__set__('p_search_search_by_value', search_orig);
			sandbox.restore();
		});

		it('Nominal path, listUsersExternal', async function () {
			let err = undefined;
			let res;
			try {
				res = await user.listUsersExternal(TEST_LIST_USER_JSON);
			} catch (error) {
				err = error;
			}
			assert.ok(res[0].role !== undefined);
			assert.equal(res[0].role.role, TEST_LIST_USER_ROLE_SEARCH_RESPONSE.role);
			assert.equal(res[0].username, TEST_LIST_USER_SEARCH_RESPONSE.username);
			assert.equal(res[0].password, undefined);
		});

		it('bad role search result', async function () {
			search_stub = sinon.stub();
			search_stub.onFirstCall().throws(new Error(BAD_ROLE_SEARCH_RESULT));
			user.__set__('p_search_search_by_value', search_stub);
			let err = undefined;
			try {
				let res = await user.listUsersExternal(TEST_LIST_USER_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(err.message, BAD_ROLE_SEARCH_RESULT);
		});

		it('bad user search result', async function () {
			search_stub.onSecondCall().throws(new Error(USER_SEARCH_FAILED_RESULT));
			user.__set__('p_search_search_by_value', search_stub);
			let err = undefined;
			try {
				let res = await user.listUsersExternal(TEST_LIST_USER_JSON);
			} catch (error) {
				err = error;
			}
			assert.equal(err.message, USER_SEARCH_FAILED_RESULT);
		});
	});

	describe('Test appendSystemTablesToRole function', function () {
		it('validate permissions are added for system tables.', function (done) {
			let role_temp = test_utils.deepClone(VALID_ROLE);
			let temp_append = user.__get__('appendSystemTablesToRole');
			temp_append(role_temp);
			assert.notEqual(role_temp.permission.system.tables, undefined, 'expected system tables to be created');
			assert.notEqual(role_temp.permission.system.tables.hdb_role, undefined, 'expected system tables to be created');
			done();
		});
	});

	describe('Test isClusterUser function', () => {
		const isClusterUser = user.__get__('isClusterUser');

		it('Test cluster user true is returned', () => {
			let test_user_copy = test_utils.deepClone(TEST_USER);
			test_user_copy.role.permission.cluster_user = true;
			global.hdb_users = new Map([[TEST_USER.username, test_user_copy]]);
			const result = isClusterUser('test_user');

			assert.equal(result, true);
		});

		it('Test cluster user false is returned', () => {
			global.hdb_users = new Map([[TEST_USER.username, TEST_USER]]);
			const result = isClusterUser('test_user');

			assert.equal(result, false);
		});
	});

	describe('Test findAndValidateUser function', () => {
		it('Nominal test, expect user returned', async () => {
			let test_user_copy = test_utils.deepClone(TEST_USER);
			test_user_copy.password = 'some-salt8b268af38be8279caefa5d014a1241db';
			global.hdb_users = new Map([[TEST_USER.username, test_user_copy]]);
			const expected_result = {
				active: true,
				username: 'test_user',
				role: {
					id: '08fec166-bbfb-4822-ab3d-9cb4baeff86f',
					permission: {
						super_user: true,
					},
					role: 'super_user',
				},
			};
			const result = await user.findAndValidateUser('test_user', 'test1234!');

			assert.deepEqual(result, expected_result);
		});

		it('Test error thrown on invalid password', async () => {
			let test_user_copy = test_utils.deepClone(TEST_USER);
			test_user_copy.password = 'this is not the right password';
			global.hdb_users = new Map([[TEST_USER.username, test_user_copy]]);
			const expected_err = test_utils.generateHDBError('Login failed', 401);
			await test_utils.assertErrorAsync(user.findAndValidateUser, ['test_user', 'test1234!'], expected_err);
		});

		it('Test error thrown for inactive user', async () => {
			let test_user_copy = test_utils.deepClone(TEST_USER);
			test_user_copy.active = false;
			global.hdb_users = new Map([[TEST_USER.username, test_user_copy]]);
			const expected_err = test_utils.generateHDBError('Cannot complete request: User is inactive', 401);
			await test_utils.assertErrorAsync(user.findAndValidateUser, ['test_user', 'test1234!'], expected_err);
		});

		it('Test error thrown if user not found', async () => {
			let test_user_copy = test_utils.deepClone(TEST_USER);
			global.hdb_users = new Map([[TEST_USER.username, test_user_copy]]);
			const expected_err = test_utils.generateHDBError('Login failed', 401);
			await test_utils.assertErrorAsync(user.findAndValidateUser, ['jerry', 'test1234!'], expected_err);
		});
	});

	describe('Test getClusterUser function', () => {
		it('Test cluster user returns all the required cluster user details', async () => {
			const expected_result = {
				active: true,
				hash: 'blahbblah',
				password: 'somepass',
				role: {
					id: '58aa0e11-b761-4ade-8a7d-e90f1d99d246',
					permission: {
						cluster_user: true,
					},
					role: 'cluster_user',
				},
				username: 'cluster_user',
				decrypt_hash: 'a_password@123/!',
				uri_encoded_d_hash: 'a_password%40123%2F!',
				uri_encoded_name: 'cluster_user',
				sys_name: 'cluster_user-admin',
				sys_name_encoded: 'cluster_user-admin',
			};
			const list_users_stub = sandbox.stub().resolves(USER_SEARCH_RESULT);
			sandbox.stub(crypto_hash, 'decrypt').returns('a_password@123/!');
			const list_user_rw = user.__set__('listUsers', list_users_stub);
			sandbox.stub(config_utils, 'getConfigFromFile').returns('cluster_user');
			const result = await user.getClusterUser();
			expect(result).to.eql(expected_result);
			list_user_rw();
		});
	});
});
