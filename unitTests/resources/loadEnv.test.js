'use strict';

const assert = require('node:assert');
const { handleApplication } = require('#src/resources/loadEnv');
const {
	registerEnvSecretDecryptor,
	getEnvSecretDecryptor,
	clearEnvSecretDecryptor,
} = require('#src/resources/envSecretDecryptor');

// A minimal Scope stand-in: captures the entry handler so the test can drive it directly.
function fakeScope(options = {}) {
	let handler;
	return {
		options: { getAll: () => options },
		handleEntry(cb) {
			handler = cb;
		},
		requestRestart() {},
		fire(entry) {
			handler(entry);
		},
	};
}

const addEntry = (contents) => ({ eventType: 'add', absolutePath: '/fake/.env', contents });

describe('loadEnv env-secret decryption hook', () => {
	const TOUCHED = ['__ENVTEST_A', '__ENVTEST_B', '__ENVTEST_C', '__ENVTEST_D', '__ENVTEST_E'];

	afterEach(() => {
		clearEnvSecretDecryptor();
		for (const k of TOUCHED) delete process.env[k];
	});

	describe('envSecretDecryptor registry', () => {
		it('registers, returns, and clears the decryptor', () => {
			assert.equal(getEnvSecretDecryptor(), undefined);
			const fn = (v) => v;
			registerEnvSecretDecryptor(fn);
			assert.equal(getEnvSecretDecryptor(), fn);
			clearEnvSecretDecryptor();
			assert.equal(getEnvSecretDecryptor(), undefined);
		});
	});

	it('loads plaintext values unchanged', () => {
		const scope = fakeScope();
		handleApplication(scope);
		scope.fire(addEntry('__ENVTEST_A=1\n__ENVTEST_B=two words'));
		assert.equal(process.env.__ENVTEST_A, '1');
		assert.equal(process.env.__ENVTEST_B, 'two words');
	});

	it('decrypts enc:v1 values when a decryptor is registered', () => {
		registerEnvSecretDecryptor((value) => `decrypted(${value.slice('enc:v1:'.length)})`);
		const scope = fakeScope();
		handleApplication(scope);
		scope.fire(addEntry('__ENVTEST_A=plain\n__ENVTEST_C=enc:v1:SECRET'));
		assert.equal(process.env.__ENVTEST_A, 'plain', 'plaintext still passes through');
		assert.equal(process.env.__ENVTEST_C, 'decrypted(SECRET)');
	});

	it('skips encrypted values when no decryptor is registered', () => {
		const scope = fakeScope();
		handleApplication(scope);
		scope.fire(addEntry('__ENVTEST_D=enc:v1:nodecryptor'));
		assert.equal(process.env.__ENVTEST_D, undefined);
	});

	it('skips a value the decryptor cannot decrypt rather than storing ciphertext', () => {
		registerEnvSecretDecryptor(() => {
			throw new Error('bad envelope');
		});
		const scope = fakeScope();
		handleApplication(scope);
		scope.fire(addEntry('__ENVTEST_E=enc:v1:corrupt'));
		assert.equal(process.env.__ENVTEST_E, undefined);
	});
});
