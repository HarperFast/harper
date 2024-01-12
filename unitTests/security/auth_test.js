'use strict';
const test_utils = require('../test_utils');
test_utils.preTestPrep();
const assert = require('assert');
const rewire = require('rewire');
const auth = rewire('../../security/fastifyAuth');
const token_auth = rewire('../../security/tokenAuthentication');
const password_function = require('../../utility/password');
const hdb_error = require('../../utility/errors/hdbError').handleHDBError;

const PASSPHRASE_VALUE = '6340b357-55b2-4fc8-b359-cae7d90c8c01';
const PRIVATE_KEY_VALUE =
	'-----BEGIN ENCRYPTED PRIVATE KEY-----\n' +
	'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\n' +
	'-----END ENCRYPTED PRIVATE KEY-----';
const PUBLIC_KEY_VALUE =
	'-----BEGIN PUBLIC KEY-----\n' +
	'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAyt3aWGKRiAY0gmCjPDTo\n' +
	'5Q2x6+IuHj7PQrNwGiAA/cgve9v2UCRGN/PSwLtT2mJPdW3jdEX2AgZcVEhA4N16\n' +
	'cJm/Bm6NdPSUr+4nn4bYpApbUIc5aCEk67swzWC+MMcK47MOAc0CqrN/50ZwsaB2\n' +
	'ij+JaW7foDS8fNX+i1ytvHFTNj1zNsAicqdKRGRt4EtXRfU/A5AUjIJ95LxOGSmg\n' +
	'ri+rmBZRh1olw+EWoHX/QWFFxKSEmCgmD2RYID0jedQnf7ABSrmXPBm2t2+08CrP\n' +
	'SHc+0lK7TC2KDUggGs3t+932HwXCBJ1ZxvX6kZ9TMhXenxU67lFXLOQlxnH7uDOH\n' +
	'xUPkOKHxJq+Bpgpmw30HyhCMPdHhjbNND94TTzrBy+V6OYKgI9wYXwAL4viXuSyN\n' +
	'oAn67PXvC3OhA08cmZlN6q7UWK5+WkKy7Adw++iTqH/ERRfXrx6XQ09b97cMN28d\n' +
	'SUbT4WgurLkfCDeUXKI3buIFzNvlmnrYI1PP5/K5NK8qbBQkE0ejVWg4igvdD4mf\n' +
	'oNjL5EflpeS3+wDywCyuhfPimygitufTI5ttUF+NkHmQNGOK4vCp89L8NUGaWL12\n' +
	'Xbe/Q0MHiGt7hvhB51+C08m+qxIDk2l8Icg77mS4WuxBbWBxN/FF18ttp4GfHJWw\n' +
	'brlmQxVf0PFY+0tM8fCkpccCAwEAAQ==\n' +
	'-----END PUBLIC KEY-----';

const JWTObjects = require('../../security/JWTObjects');

const VALID_ROLE = {
	permission: {
		super_user: true,
	},
	id: 'c7035e09-5f5b-43b1-8ba9-c945f8c9da35',
	role: 'super_user',
};

global.hdb_users = new Map([
	[
		'nook',
		{
			username: 'nook',
			active: true,
			password: password_function.hash('1234!'),
			role: VALID_ROLE,
		},
	],
	[
		'unactivenook',
		{
			username: 'unactivenook',
			active: false,
			password: password_function.hash('1234!'),
			role: VALID_ROLE,
		},
	],
]);

let active_basic_request = {
	headers: {
		authorization: 'Basic ' + Buffer.from('nook:1234!').toString('base64'),
	},
};

let invalid_password_basic_request = {
	headers: {
		authorization: 'Basic ' + Buffer.from('nook:1234').toString('base64'),
	},
};

let unactive_basic_request = {
	headers: {
		authorization: 'Basic ' + Buffer.from('unactivenook:1234!').toString('base64'),
	},
};

let invalid_basic_user = {
	headers: {
		authorization: 'Basic ' + Buffer.from('nonook:1234').toString('base64'),
	},
};

let active_other_request = {
	body: {
		username: 'nook',
		password: '1234!',
	},
};

let invalid_password_other_request = {
	body: {
		username: 'nook',
		password: '1234',
	},
};

let unactive_other_request = {
	body: {
		username: 'unactivenook',
		password: '1234!',
	},
};

let invalid_other_user = {
	body: {
		username: 'nouser',
		password: '1234!',
	},
};

describe('Test authorize function', function () {
	it('Cannot complete request Basic authorization: User not found ', function (done) {
		auth.authorize(invalid_basic_user, null, function (err, user) {
			assert.equal(err.message, 'Login failed', "Cannot complete request: User 'nonook' not found");
			done();
		});
	});

	it('Cannot complete request Basic authorization: User is inactive', function (done) {
		auth.authorize(unactive_basic_request, null, function (err, user) {
			assert.equal(
				err.message,
				'Cannot complete request: User is inactive',
				'Cannot complete request: User is inactive'
			);
			done();
		});
	});

	it('Cannot complete request Basic authorization:  Invalid password', function (done) {
		auth.authorize(invalid_password_basic_request, null, function (err, user) {
			assert.equal(err.message, 'Login failed');
			done();
		});
	});

	it('Can authorize with correct username and password Basic authorization', function (done) {
		auth.authorize(active_basic_request, null, function (err, user) {
			let role_temp = test_utils.deepClone(VALID_ROLE);
			assert.deepEqual(user, { username: 'nook', active: true, role: role_temp }, 'equal object');
			assert.equal(err, null, 'no error');
			done();
		});
	});

	//other authorization
	it('Cannot complete request Other authorization: User not found ', function (done) {
		auth.authorize(invalid_other_user, null, function (err, user) {
			assert.equal(err.message, 'Login failed', "Cannot complete request: User 'nouser' not found");
			done();
		});
	});

	it('Cannot complete request Other authorization: User is inactive', function (done) {
		auth.authorize(unactive_other_request, null, function (err, user) {
			assert.equal(
				err.message,
				'Cannot complete request: User is inactive',
				'Cannot complete request: User is inactive'
			);
			done();
		});
	});

	it('Cannot complete request Other authorization:  Invalid password', function (done) {
		auth.authorize(invalid_password_other_request, null, function (err, user) {
			assert.equal(err.message, 'Login failed');
			done();
		});
	});

	it('Can authorize with correct username and password Other authorization', function (done) {
		auth.authorize(active_other_request, null, function (err, user) {
			let role_temp = test_utils.deepClone(VALID_ROLE);
			assert.deepEqual(user, { username: 'nook', active: true, role: role_temp }, 'equal object');
			assert.equal(err, null, 'no error');
			done();
		});
	});
});

describe('test authorize function for JWT', () => {
	let rw_get_tokens;
	let rw_validate_user;
	let rw_token_auth;
	let hdb_admin_tokens;
	let old_user_tokens;
	let non_user_tokens;
	let op_token_timeout;
	let r_token_timeout;
	let expired_user_tokens;
	let orig_hdb_users = global.hdb_users;
	before(async () => {
		rw_get_tokens = token_auth.__set__(
			'getJWTRSAKeys',
			async () => new JWTObjects.JWTRSAKeys(PUBLIC_KEY_VALUE, PRIVATE_KEY_VALUE, PASSPHRASE_VALUE)
		);

		rw_validate_user = token_auth.__set__('user_functions', {
			findAndValidateUser: async (u, pw) => ({ username: u }),
		});

		let rw_update = token_auth.__set__('update', async (update_object) => {
			return { message: 'updated 1 of 1', update_hashes: ['1'], skipped_hashes: [] };
		});

		let rw_signalling = token_auth.__set__('signalling', {
			signalUserChange: (obj) => {},
		});

		global.hdb_users = new Map([
			['HDB_ADMIN', { username: 'HDB_ADMIN', active: true }],
			['old_user', { username: 'old_user', active: false }],
		]);

		op_token_timeout = token_auth.__set__('OPERATION_TOKEN_TIMEOUT', '-1');
		r_token_timeout = token_auth.__set__('REFRESH_TOKEN_TIMEOUT', '-1');
		expired_user_tokens = await token_auth.createTokens({ username: 'EXPIRED', password: 'cool' });
		op_token_timeout();
		r_token_timeout();

		rw_token_auth = auth.__set__('token_authentication', token_auth);

		hdb_admin_tokens = await token_auth.createTokens({ username: 'HDB_ADMIN', password: 'cool' });
		old_user_tokens = await token_auth.createTokens({ username: 'old_user', password: 'notcool' });
		non_user_tokens = await token_auth.createTokens({ username: 'non_user', password: 'notcool' });
		global.hdb_users.get('HDB_ADMIN').refresh_token = password_function.hash(hdb_admin_tokens.refresh_token);
		rw_validate_user();
		rw_signalling();
		rw_update();
	});

	after(() => {
		rw_get_tokens();
		rw_token_auth();
		global.hdb_users = orig_hdb_users;
	});

	it('test hdb_admin operation token', (done) => {
		let request = {
			headers: {
				authorization: 'Bearer ' + hdb_admin_tokens.operation_token,
			},
		};

		auth.authorize(request, null, function (err, user) {
			assert.deepStrictEqual(user.username, 'HDB_ADMIN', 'equal username');
			assert.deepStrictEqual(user.active, true, 'equal active');
			assert.equal(err, null, 'no error');
			done();
		});
	});

	it('test old_user operation token', (done) => {
		let request = {
			headers: {
				authorization: 'Bearer ' + old_user_tokens.operation_token,
			},
		};

		auth.authorize(request, null, function (err, user) {
			assert.deepStrictEqual(user, undefined);
			assert.deepStrictEqual(err, hdb_error(new Error(), 'invalid token', 401), ' error');
			done();
		});
	});

	it('test non-existent user operation token', (done) => {
		let request = {
			headers: {
				authorization: 'Bearer ' + non_user_tokens.operation_token,
			},
		};

		auth.authorize(request, null, function (err, user) {
			assert.deepStrictEqual(user, { username: 'non_user' });
			done();
		});
	});

	it('test bad operation token', (done) => {
		let request = {
			headers: {
				authorization: 'Bearer BAD_TOKEN',
			},
		};

		auth.authorize(request, null, function (err, user) {
			assert.deepStrictEqual(user, undefined);
			assert.deepStrictEqual(err, hdb_error(new Error(), 'invalid token', 401), ' error');
			done();
		});
	});

	it('test expired operation token', (done) => {
		let request = {
			headers: {
				authorization: 'Bearer ' + expired_user_tokens.operation_token,
			},
		};

		auth.authorize(request, null, function (err, user) {
			assert.deepStrictEqual(user, undefined);
			assert.deepStrictEqual(err, hdb_error(new Error(), 'token expired', 403), ' error');
			done();
		});
	});

	it('test hdb_admin refresh token', (done) => {
		let request = {
			headers: {
				authorization: 'Bearer ' + hdb_admin_tokens.refresh_token,
			},
			body: {
				operation: 'refresh_operation_token',
			},
		};

		auth.authorize(request, null, function (err, user) {
			assert.notDeepStrictEqual(user, undefined);
			assert.deepStrictEqual(user.username, 'HDB_ADMIN');
			assert.deepStrictEqual(user.active, true);
			assert.deepStrictEqual(err, null, ' error');
			assert.deepStrictEqual(request.body.refresh_token, hdb_admin_tokens.refresh_token);
			done();
		});
	});

	it('test old_user refresh token', (done) => {
		let request = {
			headers: {
				authorization: 'Bearer ' + old_user_tokens.refresh_token,
			},
			body: {
				operation: 'refresh_operation_token',
			},
		};

		auth.authorize(request, null, function (err, user) {
			assert.deepStrictEqual(user, undefined);
			assert.deepStrictEqual(err, hdb_error(new Error(), 'invalid token', 401), ' error');
			assert.deepStrictEqual(request.body.refresh_token, undefined);
			done();
		});
	});

	it('test non-existent refresh user', (done) => {
		let request = {
			headers: {
				authorization: 'Bearer ' + non_user_tokens.refresh_token,
			},
			body: {
				operation: 'refresh_operation_token',
			},
		};

		auth.authorize(request, null, function (err, user) {
			assert.deepStrictEqual(user, undefined);
			assert.deepStrictEqual(err, hdb_error(new Error(), 'invalid token', 401), ' error');
			assert.deepStrictEqual(request.body.refresh_token, undefined);
			done();
		});
	});

	it('test bad refresh token', (done) => {
		let request = {
			headers: {
				authorization: 'Bearer BAD_TOKEN',
			},
			body: {
				operation: 'refresh_operation_token',
			},
		};

		auth.authorize(request, null, function (err, user) {
			assert.deepStrictEqual(user, undefined);
			assert.deepStrictEqual(err, hdb_error(new Error(), 'invalid token', 401), ' error');
			assert.deepStrictEqual(request.body.refresh_token, undefined);
			done();
		});
	});

	it('test expired refresh token', (done) => {
		let request = {
			headers: {
				authorization: 'Bearer ' + expired_user_tokens.refresh_token,
			},
			body: {
				operation: 'refresh_operation_token',
			},
		};

		auth.authorize(request, null, function (err, user) {
			assert.deepStrictEqual(user, undefined);
			assert.deepStrictEqual(err, hdb_error(new Error(), 'token expired', 403), ' error');
			assert.deepStrictEqual(request.body.refresh_token, undefined);
			done();
		});
	});
});

let check_permission_empty_object = {
	user: {},
	schema: {},
	table: {},
};

let no_schema_user = {
	role: {
		permission: JSON.stringify({
			super_user: false,
		}),
	},
};

let no_table_user = {
	role: {
		permission: JSON.stringify({
			super_user: false,
			dev: {
				tables: {},
			},
		}),
	},
};

let no_insert_permission_user = {
	role: {
		permission: JSON.stringify({
			super_user: false,
			dev: {
				tables: {
					dog: {
						// insert: false
					},
				},
			},
		}),
	},
};

let missing_attribute_user = {
	role: {
		permission: JSON.stringify({
			super_user: false,
			dev: {
				tables: {
					dog: {
						insert: true,
						read: true,
						attribute_permissions: [],
					},
				},
			},
		}),
	},
};

let attribute_read_all_false_user = {
	role: {
		permission: JSON.stringify({
			super_user: false,
			dev: {
				tables: {
					dog: {
						insert: true,
						read: true,
						attribute_permissions: [
							{
								attribute_name: 'name',
								read: false,
							},
							{
								attribute_name: 'id',
								read: false,
							},
						],
					},
				},
			},
		}),
	},
};

let attribute_read_some_false_user = {
	role: {
		permission: JSON.stringify({
			super_user: false,
			dev: {
				tables: {
					dog: {
						insert: true,
						read: true,
						attribute_permissions: [
							{
								attribute_name: 'name',
								insert: true,
							},
							{
								attribute_name: 'id',
								insert: false,
							},
						],
					},
				},
			},
		}),
	},
};

let user = {
	role: {
		permission: JSON.stringify({
			super_user: false,
			dev: {
				tables: {
					dog: {
						insert: true,
						read: true,
						attribute_permissions: [
							{
								attribute_name: 'name',
								insert: true,
							},
							{
								attribute_name: 'id',
								insert: true,
							},
						],
					},
				},
			},
		}),
	},
};

let no_restrict_attribute_user = {
	role: {
		permission: JSON.stringify({
			super_user: false,
			dev: {
				tables: {
					dog: {
						insert: true,
						read: true,
					},
				},
			},
		}),
	},
};

let check_permission_no_attributes_object = {
	schema: 'dev',
	table: 'dog',
	operation: 'insert',
	attributes: false,
};

let check_permission_object = {
	schema: 'dev',
	table: 'dog',
	operation: 'insert',
	attributes: ['name', 'id'],
};

let super_user = {
	role: {
		permission: JSON.stringify({
			super_user: true,
			dev: {
				tables: {
					dog: {
						insert: true,
					},
				},
			},
		}),
	},
};

let check_super_user_permission_object = {
	schema: 'dev',
	table: 'dog',
	operation: 'insert',
};

let permission_object_no_role = {
	user: {
		role: {},
	},
	schema: {
		harper: {},
	},
	table: {
		dog: {},
	},
	operation: {
		insert: {},
	},
};

describe('Test checkPermissions function', function () {
	it('validate permission object, should get error when object is incomplete ', function (done) {
		auth.checkPermissions(check_permission_empty_object, function (err, result) {
			assert.equal(err.message, "Operation can't be blank", 'no error');
			done();
		});
	});

	it('no permission role in object should error ', function (done) {
		auth.checkPermissions(permission_object_no_role, function (err, result) {
			assert.equal(err, 'Invalid role', 'Invalid role');
			done();
		});
	});

	it('super_user permission can authorized', function (done) {
		check_super_user_permission_object.user = super_user;
		auth.checkPermissions(check_super_user_permission_object, function (err, result) {
			assert.equal(err, null, 'no error');
			assert.equal(result.authorized, true, 'super user can has permission');
			done();
		});
	});

	it('Not authorized to access schema when no schema name', function (done) {
		check_permission_object.user = no_schema_user;
		auth.checkPermissions(check_permission_object, function (err, result) {
			assert.equal(err, null, 'no error');
			assert.equal(result.authorized, false, 'Not authorized to access schema');
			done();
		});
	});

	it('Not authorized to access table when no table name', function (done) {
		check_permission_object.user = no_table_user;
		auth.checkPermissions(check_permission_object, function (err, result) {
			assert.equal(err, null, 'no error');
			assert.equal(result.authorized, false, 'Not authorized to access table');
			done();
		});
	});

	it('Not authorized to insert table when tables no attribute', function (done) {
		check_permission_object.user = no_insert_permission_user;
		auth.checkPermissions(check_permission_object, function (err, result) {
			assert.equal(err, null, 'no error');
			assert.equal(result.authorized, false, 'Not authorized to insert table');
			done();
		});
	});

	it('Not authorized insert to table, missing restrict attribute ', function (done) {
		check_permission_no_attributes_object.user = missing_attribute_user;
		auth.checkPermissions(check_permission_no_attributes_object, function (err, result) {
			assert.equal(err, null, 'no error');
			assert.equal(result.authorized, false, 'Not authorized insert restrict attribute to table');
			done();
		});
	});

	it('Not authorized insert restrict attribute name and id are false to table ', function (done) {
		check_permission_object.user = attribute_read_all_false_user;
		auth.checkPermissions(check_permission_object, function (err, result) {
			assert.equal(err, null, 'no error');
			assert.equal(result.authorized, false, 'Not authorized restrict attribute name, id ');
			done();
		});
	});

	it('Not authorized insert restrict attribute name is ture and id is false to table ', function (done) {
		check_permission_object.user = attribute_read_some_false_user;
		auth.checkPermissions(check_permission_object, function (err, result) {
			assert.equal(err, null, 'no error');
			assert.equal(result.authorized, false, 'Not authorized restrict attribute id ');
			done();
		});
	});

	it('can authorized with have restrict attribute true', function (done) {
		check_permission_object.user = user;
		auth.checkPermissions(check_permission_object, function (err, result) {
			assert.equal(err, null, 'no error');
			assert.equal(result.authorized, true, 'authorized restrict attribute name, id ');
			done();
		});
	});

	it('can authorized with not have restrict attribute', function (done) {
		check_permission_object.user = no_restrict_attribute_user;
		auth.checkPermissions(check_permission_object, function (err, result) {
			assert.equal(err, null, 'no error');
			assert.equal(result.authorized, true, 'authorized with not have restrict attribute');
			done();
		});
	});
});
