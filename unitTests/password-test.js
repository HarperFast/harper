require('./test_utils');
const crypto = require('crypto');

const assert = require('assert');
const { hash, validate, HASH_FUNCTION } = require('../utility/password');

const TEST_PASSWORD = 'dogs-rule-cats-drool';

function createLegacyHash(password) {
	function generateSalt(len) {
		let set = '0123456789abcdefghijklmnopqurstuvwxyzABCDEFGHIJKLMNOPQURSTUVWXYZ',
			setLen = set.length,
			salt = '';
		for (let i = 0; i < len; i++) {
			let p = Math.floor(Math.random() * setLen);
			salt += set[p];
		}
		return salt;
	}

	function createHash(password) {
		const salt = generateSalt(9);
		const hash = crypto
			.createHash('md5')
			.update(password + salt)
			.digest('hex');
		return salt + hash;
	}

	return createHash(password);
}

describe('Test password module', function () {
	describe('Hashing SHA256', function () {
		it('should generate a valid hash', async function () {
			const hashedPass = hash(TEST_PASSWORD);
			assert.strictEqual(typeof hashedPass, 'string');
			assert(hashedPass.length > 16);
			assert(validate(hashedPass, TEST_PASSWORD) === true);
		});

		it('should fail validation for incorrect password', async function () {
			const hashedPass = await hash(TEST_PASSWORD);
			assert(validate(hashedPass, 'cats-rule') === false);
		});
	});

	describe('test MD5', function () {
		it('should generate a valid MD5 hash', function () {
			const hashedPass = hash(TEST_PASSWORD, HASH_FUNCTION.MD5);
			assert.strictEqual(typeof hashedPass, 'string');
			assert(hashedPass.length > 9);
			assert(validate(hashedPass, TEST_PASSWORD, HASH_FUNCTION.MD5) === true);
		});

		it('test that legacy hashes are validated correctly using current validator', () => {
			const hash = createLegacyHash(TEST_PASSWORD);
			assert(validate(hash, TEST_PASSWORD, HASH_FUNCTION.MD5) === true);
			assert(validate(hash, 'not-good', HASH_FUNCTION.MD5) === false);
		});
	});

	describe('Test Asynchronous Hashing (Argon2id)', function () {
		it('should generate a valid async hash', async function () {
			const hashedPass = await hash(TEST_PASSWORD, HASH_FUNCTION.ARGON2ID);
			assert.strictEqual(typeof hashedPass, 'string');
			assert(hashedPass.length > 16);
			const validated = validate(hashedPass, TEST_PASSWORD, HASH_FUNCTION.ARGON2ID);
			let result = false;
			if (validated?.then) {
				result = await validated;
			}
			assert(result === true);
		});

		it('should fail async validation for incorrect password', async function () {
			const hashedPass = await hash(TEST_PASSWORD, HASH_FUNCTION.ARGON2ID);
			assert((await validate(hashedPass, 'wrongPassword', HASH_FUNCTION.ARGON2ID)) === false);
		});
	});

	describe('Empty Hash Validation', function () {
		it('should fail sync validation for empty hash', function () {
			assert(validate('', 'password') === false);
		});

		it('should fail async validation for empty hash', async function () {
			assert((await validate('', 'password')) === false);
		});
	});
});
