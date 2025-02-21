'use strict';

const test_util = require('../test_utils');
test_util.preTestPrep();
const fs = require('fs-extra');
const jwt = require('jsonwebtoken');
const path = require('path');
const assert = require('assert');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const rewire = require('rewire');
const password_function = require('../../utility/password');
let token_auth = rewire('../../security/tokenAuthentication');
const hdb_error = require('../../utility/errors/hdbError').handleHDBError;
const env_mgr = require('../../utility/environment/environmentManager');
const hdb_terms = require('../../utility/hdbTerms');
const user = require('../../security/user');
const insert = require('../../dataLayer/insert');
const signalling = require('../../utility/signalling');

const KEYS_PATH = path.join(test_util.getMockTestPath(), 'keys');
const PASSPHRASE_PATH = path.join(KEYS_PATH, '.jwtPass');
const PRIVATE_KEY_PATH = path.join(KEYS_PATH, '.jwtPrivate.key');
const PUBLIC_KEY_PATH = path.join(KEYS_PATH, '.jwtPublic.key');
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
class JWTRSAKeys {
	/**
	 * @param {string} public_key
	 * @param {string} private_key
	 * @param {string} passphrase
	 */
	constructor(public_key, private_key, passphrase) {
		this.publicKey = public_key;
		this.privateKey = private_key;
		this.passphrase = passphrase;
	}
}

describe('test getJWTRSAKeys function', () => {
	//let get_hdb_base_path_stub;
	let path_join_spy;
	let fs_readfile_spy;
	let get_jwt_keys_func;

	before(() => {
		env_mgr.setProperty(hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, test_util.getMockTestPath());
		get_jwt_keys_func = token_auth.__get__('getJWTRSAKeys');
		fs_readfile_spy = sandbox.spy(fs, 'readFile');
		path_join_spy = sandbox.spy(path, 'join');
	});

	beforeEach(() => {
		fs.mkdirpSync(KEYS_PATH);
		fs.writeFileSync(PASSPHRASE_PATH, PASSPHRASE_VALUE);
		fs.writeFileSync(PRIVATE_KEY_PATH, PRIVATE_KEY_VALUE);
		fs.writeFileSync(PUBLIC_KEY_PATH, PUBLIC_KEY_VALUE);
	});

	afterEach(() => {
		fs.removeSync(test_util.getMockTestPath());
		path_join_spy.resetHistory();
		fs_readfile_spy.resetHistory();
	});

	after(() => {
		sandbox.restore();
	});

	it('test rsa_keys is undefined, happy path', async () => {
		let rw_rsa_keys = token_auth.__set__('rsaKeys', undefined);
		let results = await get_jwt_keys_func();
		assert.notDeepStrictEqual(results, new JWTRSAKeys(PUBLIC_KEY_VALUE, PRIVATE_KEY_VALUE, PASSPHRASE_VALUE));
		assert(fs_readfile_spy.callCount === 3);
		assert(fs_readfile_spy.threw() === false);
		assert(path_join_spy.threw() === false);
		rw_rsa_keys();
	});

	it('test rsa_keys is undefined, passphrase file does not exist', async () => {
		let rw_rsa_keys = token_auth.__set__('rsaKeys', undefined);
		fs.unlinkSync(PASSPHRASE_PATH);

		let results = undefined;
		let error = undefined;
		try {
			results = await get_jwt_keys_func();
		} catch (e) {
			error = e;
		}
		assert.deepStrictEqual(results, undefined);
		assert.deepStrictEqual(
			error.message,
			'unable to generate JWT as there are no encryption keys.  please contact your administrator'
		);

		let fs_error;
		try {
			await fs_readfile_spy.lastCall.returnValue;
		} catch (e) {
			fs_error = e;
		}
		assert.deepStrictEqual(fs_error.code, 'ENOENT');

		rw_rsa_keys();
	});

	it('test rsa_keys is undefined, private key file does not exist', async () => {
		let rw_rsa_keys = token_auth.__set__('rsaKeys', undefined);
		fs.unlinkSync(PRIVATE_KEY_PATH);

		let results = undefined;
		let error = undefined;
		try {
			results = await get_jwt_keys_func();
		} catch (e) {
			error = e;
		}
		assert.deepStrictEqual(results, undefined);
		assert.deepStrictEqual(
			error.message,
			'unable to generate JWT as there are no encryption keys.  please contact your administrator'
		);

		let fs_error;
		try {
			await fs_readfile_spy.lastCall.returnValue;
		} catch (e) {
			fs_error = e;
		}
		assert.deepStrictEqual(fs_error.code, 'ENOENT');

		rw_rsa_keys();
	});

	it('test rsa_keys is undefined, public key file does not exist', async () => {
		let rw_rsa_keys = token_auth.__set__('rsaKeys', undefined);
		fs.unlinkSync(PUBLIC_KEY_PATH);

		let results = undefined;
		let error = undefined;
		try {
			results = await get_jwt_keys_func();
		} catch (e) {
			error = e;
		}
		assert.deepStrictEqual(results, undefined);
		assert.deepStrictEqual(
			error.message,
			'unable to generate JWT as there are no encryption keys.  please contact your administrator'
		);

		assert(path_join_spy.callCount === 3 || path_join_spy.callCount === 4);
		assert(fs_readfile_spy.callCount === 3);

		let fs_error;
		try {
			await fs_readfile_spy.lastCall.returnValue;
		} catch (e) {
			fs_error = e;
		}
		assert.deepStrictEqual(fs_error.code, 'ENOENT');

		rw_rsa_keys();
	});

	it('test rsa_keys is defined', async () => {
		let rw_rsa_keys = token_auth.__set__(
			'rsaKeys',
			new JWTRSAKeys(PUBLIC_KEY_VALUE, PRIVATE_KEY_VALUE, PASSPHRASE_VALUE)
		);

		let results = await get_jwt_keys_func();

		assert.deepStrictEqual(results, new JWTRSAKeys(PUBLIC_KEY_VALUE, PRIVATE_KEY_VALUE, PASSPHRASE_VALUE));

		assert(path_join_spy.callCount === 0);
		assert(fs_readfile_spy.callCount === 0);

		rw_rsa_keys();
	});
});

describe('test createTokens', () => {
	let validate_user_stub;
	let update_stub;
	let signalling_stub;
	beforeEach(() => {
		validate_user_stub = sandbox.stub(user, 'findAndValidateUser').callsFake(async (u, pw) => {
			return { username: u, role: { permission: { super_user: true } } };
		});
		update_stub = sandbox.stub(insert, 'update').callsFake(async (update_object) => {
			return { message: 'updated 1 of 1', update_hashes: ['1'], skipped_hashes: [] };
		});
		signalling_stub = sandbox.stub(signalling, 'signalUserChange').callsFake((obj) => {});
	});

	afterEach(() => {
		validate_user_stub.restore();
		update_stub.restore();
		signalling_stub.restore();
	});

	it('test validation', async () => {
		let error;
		let result;
		//test null
		try {
			result = await token_auth.createTokens();
		} catch (e) {
			error = e;
		}
		assert.deepStrictEqual(result, undefined);
		assert.deepStrictEqual(error.message, 'invalid credentials');

		//test not object arg
		try {
			result = await token_auth.createTokens('bad');
		} catch (e) {
			error = e;
		}
		assert.deepStrictEqual(result, undefined);
		assert.deepStrictEqual(error.message, "'value' must be of type object");

		//test no username
		try {
			result = await token_auth.createTokens({ username: 'bad-guy' });
		} catch (e) {
			error = e;
		}
		assert.deepStrictEqual(result, undefined);
		assert.deepStrictEqual(error.message, "'value' contains [username] without its required peers [password]");

		//test no password
		try {
			result = await token_auth.createTokens({ password: 'HDB_ADMIN' });
		} catch (e) {
			error = e;
		}
		assert.deepStrictEqual(result, undefined);
		assert.deepStrictEqual(error.message, "'value' contains [password] without its required peers [username]");

		//test bad credentials
		validate_user_stub.callsFake(async (u, pw) => {
			throw new Error('bad credentials');
		});

		try {
			result = await token_auth.createTokens({ username: 'BAD_USER', password: 'blerrrrg' });
		} catch (e) {
			error = e;
		}
		assert.deepStrictEqual(result, undefined);
		assert.deepStrictEqual(error.message, 'invalid credentials');

		//test good credentials, no RSA keys
		validate_user_stub.callsFake(async (u, pw) => ({ username: u }));
		try {
			result = await token_auth.createTokens({ username: 'HDB_USER', password: 'pass' });
		} catch (e) {
			error = e;
		}
		assert.deepStrictEqual(result, undefined);
		assert.deepStrictEqual(
			error.message,
			'unable to generate JWT as there are no encryption keys.  please contact your administrator'
		);
	});

	it('test happy path', async () => {
		let rw_get_tokens = token_auth.__set__(
			'getJWTRSAKeys',
			async () => new JWTRSAKeys(PUBLIC_KEY_VALUE, PRIVATE_KEY_VALUE, PASSPHRASE_VALUE)
		);
		let result = await token_auth.createTokens({ username: 'HDB_USER', password: 'pass' });
		let refresh_payload = jwt.decode(result.refresh_token);
		let operation_payload = jwt.decode(result.operation_token);
		assert.notDeepStrictEqual(result, undefined);
		assert.notDeepStrictEqual(result.operation_token, undefined);
		assert.notDeepStrictEqual(result.refresh_token, undefined);

		let expected_payload_attributes = ['username', 'super_user', 'cluster_user'];
		expected_payload_attributes.forEach((attr) => {
			assert.deepStrictEqual(refresh_payload.hasOwnProperty(attr), true);
			assert.deepStrictEqual(operation_payload.hasOwnProperty(attr), true);
		});

		rw_get_tokens();
	});

	it('test update failed', async () => {
		update_stub.callsFake(async (update_object) => {
			throw Error('update failed');
		});

		let rw_get_tokens = token_auth.__set__(
			'getJWTRSAKeys',
			async () => new JWTRSAKeys(PUBLIC_KEY_VALUE, PRIVATE_KEY_VALUE, PASSPHRASE_VALUE)
		);
		let result;
		let error;
		try {
			result = await token_auth.createTokens({ username: 'HDB_USER', password: 'pass' });
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(result, undefined);
		assert.deepStrictEqual(error.message, 'update failed');
	});

	it('test update skipped the record', async () => {
		update_stub.callsFake(async (update_object) => {
			return { message: 'updated 0 of 1', update_hashes: [], skipped_hashes: ['1'] };
		});

		let rw_get_tokens = token_auth.__set__(
			'getJWTRSAKeys',
			async () => new JWTRSAKeys(PUBLIC_KEY_VALUE, PRIVATE_KEY_VALUE, PASSPHRASE_VALUE)
		);
		let result;
		let error;
		try {
			result = await token_auth.createTokens({ username: 'HDB_USER', password: 'pass' });
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(result, undefined);
		assert.deepStrictEqual(error.message, 'unable to store refresh_token');
	});
});

describe('test validateOperationToken function', () => {
	let rw_get_tokens;
	let validate_user_stub;
	let jwt_spy;
	let hdb_admin_tokens;
	let old_user_tokens;
	let non_user_tokens;
	before(async () => {
		sandbox.restore();

		rw_get_tokens = token_auth.__set__(
			'getJWTRSAKeys',
			async () => new JWTRSAKeys(PUBLIC_KEY_VALUE, PRIVATE_KEY_VALUE, PASSPHRASE_VALUE)
		);

		let update_stub = sandbox.stub(insert, 'update').callsFake(async (update_object) => {
			return { message: 'updated 1 of 1', update_hashes: ['1'], skipped_hashes: [] };
		});

		let signalling_stub = sandbox.stub(signalling, 'signalUserChange').callsFake((obj) => {});
		validate_user_stub = sandbox.stub(user, 'findAndValidateUser').callsFake(async (u, pw) => ({ username: u }));

		await user.setUsersWithRolesCache(
			new Map([
				['HDB_ADMIN', { username: 'HDB_ADMIN', active: true }],
				['old_user', { username: 'old_user', active: false }],
			])
		);

		token_timeout = token_auth.__set__('OPERATION_TOKEN_TIMEOUT', '-1');
		expired_user_tokens = await token_auth.createTokens({ username: 'EXPIRED', password: 'cool' });
		token_timeout();

		hdb_admin_tokens = await token_auth.createTokens({ username: 'HDB_ADMIN', password: 'cool' });
		old_user_tokens = await token_auth.createTokens({ username: 'old_user', password: 'notcool' });
		non_user_tokens = await token_auth.createTokens({ username: 'non_user', password: 'notcool' });
		validate_user_stub.restore();
		jwt_spy = sandbox.spy(jwt, 'verify');
		validate_user_stub = sandbox.spy(user, 'findAndValidateUser');

		update_stub.restore();
		signalling_stub.restore();
	});
	let token_timeout;
	let expired_user_tokens;

	afterEach(() => {
		jwt_spy.resetHistory();
		validate_user_stub.resetHistory();
	});

	after(() => {
		rw_get_tokens();
		sandbox.restore();
	});

	it('test hdb_admin token', async () => {
		let error;
		let user;
		try {
			user = await token_auth.validateOperationToken(hdb_admin_tokens.operation_token);
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error, undefined);
		assert.deepStrictEqual(user, { active: true, username: 'HDB_ADMIN' });
		assert(jwt_spy.callCount === 1);
		assert(jwt_spy.threw() === false);
		assert(validate_user_stub.callCount === 1);
		assert(validate_user_stub.threw() === false);
	});

	it('test old_user token', async () => {
		let error;
		let user;
		try {
			user = await token_auth.validateOperationToken(old_user_tokens.operation_token);
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error.message, 'invalid token');
		assert.deepStrictEqual(user, undefined);
		assert(jwt_spy.callCount === 1);
		assert(jwt_spy.threw() === false);
		assert(validate_user_stub.callCount === 1);
		let validate_error;
		try {
			await validate_user_stub.firstCall.returnValue;
		} catch (e) {
			validate_error = e;
		}
		assert(validate_error !== undefined);
		assert.deepStrictEqual(validate_error.message, 'Cannot complete request: User is inactive');
	});

	it('test non-existent user', async () => {
		let error;
		let user;
		try {
			user = await token_auth.validateOperationToken(non_user_tokens.operation_token);
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(user, { username: 'non_user' });
		assert(jwt_spy.callCount === 1);
		assert(jwt_spy.threw() === false);
		assert(validate_user_stub.callCount === 1);
		let validate_error;
		try {
			await validate_user_stub.firstCall.returnValue;
		} catch (e) {
			validate_error = e;
		}
		assert(validate_error === undefined);
	});

	it('test bad token', async () => {
		let error;
		try {
			await token_auth.validateOperationToken('BAD_TOKEN');
		} catch (e) {
			error = e;
		}
		assert.deepStrictEqual(error.message, 'invalid token');
		assert(jwt_spy.callCount === 1);
		assert(jwt_spy.threw() === true);
		assert(validate_user_stub.callCount === 0);
	});

	it('test expired token', async () => {
		let error;
		try {
			await token_auth.validateOperationToken(expired_user_tokens.operation_token);
		} catch (e) {
			error = e;
		}
		assert.deepStrictEqual(error.message, 'token expired');
		assert.deepStrictEqual(error.statusCode, 403);
		assert(jwt_spy.callCount === 1);
		assert(jwt_spy.threw() === true);
		assert(validate_user_stub.callCount === 0);
	});
});

describe('test validateRefreshToken function', () => {
	let rw_get_tokens;
	let rw_validate_user;
	let jwt_spy;
	let validate_user_spy;
	let hdb_admin_tokens;
	let old_user_tokens;
	let non_user_tokens;
	let validate_refresh_token;
	let token_timeout;
	let expired_user_tokens;

	before(async () => {
		validate_refresh_token = token_auth.__get__('validateRefreshToken');
		rw_get_tokens = token_auth.__set__(
			'getJWTRSAKeys',
			async () => new JWTRSAKeys(PUBLIC_KEY_VALUE, PRIVATE_KEY_VALUE, PASSPHRASE_VALUE)
		);

		let update_stub = sandbox.stub(insert, 'update').callsFake(async (update_object) => {
			return { message: 'updated 1 of 1', update_hashes: ['1'], skipped_hashes: [] };
		});

		let signalling_stub = sandbox.stub(signalling, 'signalUserChange').callsFake((obj) => {});

		const validate_user_stub = sandbox.stub(user, 'findAndValidateUser').callsFake(async (u, pw) => ({ username: u }));

		token_timeout = token_auth.__set__('REFRESH_TOKEN_TIMEOUT', '-1');
		expired_user_tokens = await token_auth.createTokens({ username: 'EXPIRED', password: 'cool' });
		token_timeout();

		hdb_admin_tokens = await token_auth.createTokens({ username: 'HDB_ADMIN', password: 'cool' });
		old_user_tokens = await token_auth.createTokens({ username: 'old_user', password: 'notcool' });
		non_user_tokens = await token_auth.createTokens({ username: 'non_user', password: 'notcool' });
		const user_map = new Map([
			[
				'HDB_ADMIN',
				{
					username: 'HDB_ADMIN',
					active: true,
					refresh_token: password_function.hash(hdb_admin_tokens.refresh_token, password_function.HASH_FUNCTION.SHA256),
				},
			],
			['old_user', { username: 'old_user', active: false }],
		]);
		await user.setUsersWithRolesCache(user_map);

		validate_user_stub.restore();
		jwt_spy = sandbox.spy(jwt, 'verify');
		validate_user_spy = sandbox.spy(user, 'findAndValidateUser');
		update_stub.restore();
		signalling_stub.restore();
	});

	afterEach(() => {
		jwt_spy.resetHistory();
		validate_user_spy.resetHistory();
	});

	after(() => {
		rw_get_tokens();
		sandbox.restore();
	});

	it('test hdb_admin token', async () => {
		let error;
		let user_data;
		try {
			user_data = await validate_refresh_token(hdb_admin_tokens.refresh_token);
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error, undefined);
		assert.deepStrictEqual(user_data, {
			active: true,
			username: 'HDB_ADMIN',
			refresh_token: (await user.getUsersWithRolesCache()).get('HDB_ADMIN').refresh_token,
		});
		assert(jwt_spy.callCount === 1);
		assert(jwt_spy.threw() === false);
		assert(validate_user_spy.callCount === 1);
		assert(validate_user_spy.threw() === false);
	});

	it('test old_user token', async () => {
		let error;
		let user;
		try {
			user = await validate_refresh_token(old_user_tokens.refresh_token);
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error.message, 'invalid token');
		assert.deepStrictEqual(error.statusCode, 401);
		assert.deepStrictEqual(user, undefined);
		assert(jwt_spy.callCount === 1);
		assert(jwt_spy.threw() === false);
		assert(validate_user_spy.callCount === 1);
		let validate_error;
		try {
			await validate_user_spy.firstCall.returnValue;
		} catch (e) {
			validate_error = e;
		}
		assert(validate_error !== undefined);
		assert.deepStrictEqual(validate_error.message, 'Cannot complete request: User is inactive');
	});

	it('test non-existent user', async () => {
		let error;
		let user;
		try {
			user = await validate_refresh_token(non_user_tokens.refresh_token);
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error.message, 'invalid token');
		assert.deepStrictEqual(user, undefined);
		assert(jwt_spy.callCount === 1);
		assert(jwt_spy.threw() === false);
		assert(validate_user_spy.callCount === 1);
		let validate_error;
		try {
			await validate_user_spy.firstCall.returnValue;
		} catch (e) {
			validate_error = e;
		}
		assert(validate_error === undefined);
	});

	it('test bad token', async () => {
		let error;
		try {
			await validate_refresh_token('BAD_TOKEN');
		} catch (e) {
			error = e;
		}
		assert.deepStrictEqual(error.message, 'invalid token');
		assert(jwt_spy.callCount === 1);
		assert(jwt_spy.threw() === true);
		assert(validate_user_spy.callCount === 0);
	});

	it('test expired token', async () => {
		let error;
		try {
			await validate_refresh_token(expired_user_tokens.refresh_token);
		} catch (e) {
			error = e;
		}
		assert.deepStrictEqual(error.message, 'token expired');
		assert.deepStrictEqual(error.statusCode, 403);
		assert(jwt_spy.callCount === 1);
		assert(jwt_spy.threw() === true);
		assert(validate_user_spy.callCount === 0);
	});
});

describe('test refreshOperationToken function', () => {
	let rw_get_tokens;
	let jwt_spy;
	let validate_user_spy;

	let hdb_admin_tokens;
	let old_user_tokens;
	let non_user_tokens;
	before(async () => {
		rw_get_tokens = token_auth.__set__(
			'getJWTRSAKeys',
			async () => new JWTRSAKeys(PUBLIC_KEY_VALUE, PRIVATE_KEY_VALUE, PASSPHRASE_VALUE)
		);

		let update_stub = sandbox.stub(insert, 'update').callsFake(async (update_object) => {
			return { message: 'updated 1 of 1', update_hashes: ['1'], skipped_hashes: [] };
		});

		let signalling_stub = sandbox.stub(signalling, 'signalUserChange').callsFake((obj) => {});

		let validate_user_stub = sandbox.stub(user, 'findAndValidateUser').callsFake(async (u, pw) => ({ username: u }));

		hdb_admin_tokens = await token_auth.createTokens({ username: 'HDB_ADMIN', password: 'cool' });
		old_user_tokens = await token_auth.createTokens({ username: 'old_user', password: 'notcool' });
		non_user_tokens = await token_auth.createTokens({ username: 'non_user', password: 'notcool' });
		validate_user_stub.restore();

		await user.setUsersWithRolesCache(
			new Map([
				[
					'HDB_ADMIN',
					{
						username: 'HDB_ADMIN',
						active: true,
						role: { permission: { super_user: true } },
						refresh_token: password_function.hash(
							hdb_admin_tokens.refresh_token,
							password_function.HASH_FUNCTION.SHA256
						),
					},
				],
				['old_user', { username: 'old_user', active: false }],
			])
		);

		jwt_spy = sandbox.spy(jwt, 'verify');
		validate_user_spy = sandbox.spy(user, 'findAndValidateUser');

		update_stub.restore();
		signalling_stub.restore();
	});

	afterEach(() => {
		jwt_spy.resetHistory();
		validate_user_spy.resetHistory();
	});

	after(() => {
		rw_get_tokens();
		sandbox.restore();
	});

	it('test no body', async () => {
		let error;
		let token;
		try {
			token = await token_auth.refreshOperationToken();
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error.message, "'value' is required");
		assert.deepStrictEqual(token, undefined);

		assert.deepStrictEqual(jwt_spy.callCount, 0);
		assert.deepStrictEqual(jwt_spy.threw(), false);
		assert.deepStrictEqual(validate_user_spy.callCount, 0);
		assert.deepStrictEqual(validate_user_spy.threw(), false);
	});

	it('test no token', async () => {
		let error;
		let token;
		try {
			token = await token_auth.refreshOperationToken({});
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error.message, "'refresh_token' is required");
		assert.deepStrictEqual(token, undefined);

		assert.deepStrictEqual(jwt_spy.callCount, 0);
		assert.deepStrictEqual(jwt_spy.threw(), false);
		assert.deepStrictEqual(validate_user_spy.callCount, 0);
		assert.deepStrictEqual(validate_user_spy.threw(), false);
	});

	it('test hdb_admin token', async () => {
		let error;
		let token;
		try {
			token = await token_auth.refreshOperationToken({ refresh_token: hdb_admin_tokens.refresh_token });
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error, undefined);
		assert.notDeepStrictEqual(token, undefined);
		assert.notDeepStrictEqual(token.operation_token, undefined);

		assert.deepStrictEqual(jwt_spy.callCount, 1);
		assert.deepStrictEqual(jwt_spy.threw(), false);
		assert.deepStrictEqual(validate_user_spy.callCount, 1);
		assert.deepStrictEqual(validate_user_spy.threw(), false);

		let operation_payload = jwt.decode(token.operation_token);
		let expected_payload_attributes = ['username', 'super_user', 'cluster_user'];
		expected_payload_attributes.forEach((attr) => {
			assert.deepStrictEqual(operation_payload.hasOwnProperty(attr), true);
		});
	});

	it('test old_user token', async () => {
		let error;

		let token;
		try {
			token = await token_auth.refreshOperationToken({ refresh_token: old_user_tokens.refresh_token });
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error.message, 'invalid token');
		assert.deepStrictEqual(token, undefined);

		assert.deepStrictEqual(jwt_spy.callCount, 1);
		assert.deepStrictEqual(jwt_spy.threw(), false);
		assert.deepStrictEqual(validate_user_spy.callCount, 1);

		let validate_error;
		try {
			await validate_user_spy.firstCall.returnValue;
		} catch (e) {
			validate_error = e;
		}
		assert(validate_error !== undefined);
		assert.deepStrictEqual(validate_error.message, 'Cannot complete request: User is inactive');
	});

	it('test non-existent user', async () => {
		let error;
		let token;
		try {
			token = await token_auth.refreshOperationToken({ refresh_token: non_user_tokens.refresh_token });
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error.message, 'invalid token');
		assert.deepStrictEqual(token, undefined);
		assert.deepStrictEqual(jwt_spy.callCount, 1);
		assert.deepStrictEqual(jwt_spy.threw(), false);
		assert.deepStrictEqual(validate_user_spy.callCount, 1);
		let validate_error;
		try {
			await validate_user_spy.firstCall.returnValue;
		} catch (e) {
			validate_error = e;
		}
		assert(validate_error === undefined);
	});
});
