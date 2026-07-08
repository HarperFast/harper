'use strict';

const assert = require('node:assert');
const { handleApplication } = require('#src/resources/loadEnv');
const { registerSecretDecryptor, getSecretDecryptor, clearSecretDecryptor } = require('#src/resources/secretDecryptor');

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
		clearSecretDecryptor();
		for (const k of TOUCHED) delete process.env[k];
	});

	describe('secretDecryptor registry', () => {
		it('registers, returns, and clears the decryptor', () => {
			assert.equal(getSecretDecryptor(), undefined);
			const fn = (v) => v;
			registerSecretDecryptor(fn);
			assert.equal(getSecretDecryptor(), fn);
			clearSecretDecryptor();
			assert.equal(getSecretDecryptor(), undefined);
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
		registerSecretDecryptor((value) => `decrypted(${value.slice('enc:v1:'.length)})`);
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
		registerSecretDecryptor(() => {
			throw new Error('bad envelope');
		});
		const scope = fakeScope();
		handleApplication(scope);
		scope.fire(addEntry('__ENVTEST_E=enc:v1:corrupt'));
		assert.equal(process.env.__ENVTEST_E, undefined);
	});
});

describe('loadEnv conflict handling', () => {
	const TOUCHED = ['__ENVTEST_F', '__ENVTEST_G'];

	afterEach(() => {
		for (const k of TOUCHED) delete process.env[k];
	});

	it('warns that config-shaping vars cannot shape instance config (#1513)', () => {
		const logger = require('#src/utility/logging/harper_logger');
		const warnings = [];
		const originalWarn = logger.warn;
		logger.warn = (msg) => warnings.push(String(msg));
		try {
			const scope = fakeScope();
			handleApplication(scope);
			scope.fire(addEntry('HARPER_SET_CONFIG=http.port=1234'));
		} finally {
			logger.warn = originalWarn;
			delete process.env.HARPER_SET_CONFIG;
		}
		assert.ok(
			warnings.some((w) => w.includes('HARPER_SET_CONFIG') && w.includes('cannot shape instance configuration')),
			`warned about the config-shaping var: ${JSON.stringify(warnings)}`
		);
	});

	it('keeps the existing value on a real conflict without override', () => {
		process.env.__ENVTEST_G = 'original';
		const scope = fakeScope();
		handleApplication(scope);
		scope.fire(addEntry('__ENVTEST_G=changed'));
		assert.equal(process.env.__ENVTEST_G, 'original');
	});

	it('overrides on a real conflict when override is enabled', () => {
		process.env.__ENVTEST_G = 'original';
		const scope = fakeScope({ override: true });
		handleApplication(scope);
		scope.fire(addEntry('__ENVTEST_G=changed'));
		assert.equal(process.env.__ENVTEST_G, 'changed');
	});
});
