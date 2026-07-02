'use strict';

const assert = require('assert');
const {
	registerSecretDecryptor,
	clearSecretDecryptor,
	deferEncryptedEnvValue,
	getDeferredEncryptedEnvValues,
} = require('#src/resources/secretDecryptor');
const { handleApplication } = require('#src/resources/loadEnv');

const PREFIX = 'enc:v1:';
const TEST_KEYS = ['SDR_SECRET', 'SDR_PLAIN', 'SDR_TAKEN', 'SDR_OVERRIDE', 'SDR_BAD', 'SDR_GOOD'];

// A minimal stand-in for the component Scope that loadEnv drives: synchronously feeds one
// virtual `.env` file through handleEntry.
function fakeScope(contents, options = {}) {
	return {
		options: { getAll: () => options },
		handleEntry(callback) {
			callback({ eventType: 'add', absolutePath: '/apps/test/.env', contents });
		},
		requestRestart() {},
	};
}

describe('deferred encrypted env replay', () => {
	beforeEach(() => {
		clearSecretDecryptor();
		for (const key of TEST_KEYS) delete process.env[key];
	});
	after(() => {
		clearSecretDecryptor();
		for (const key of TEST_KEYS) delete process.env[key];
	});

	it('queues encrypted values loaded before a decryptor registers, then replays them into process.env', () => {
		handleApplication(fakeScope(`SDR_SECRET=${PREFIX}abc\nSDR_PLAIN=hello`));
		// plaintext loads immediately; the encrypted value is deferred, not dropped
		assert.equal(process.env.SDR_PLAIN, 'hello');
		assert.equal(process.env.SDR_SECRET, undefined);
		assert.equal(getDeferredEncryptedEnvValues().length, 1);
		assert.equal(getDeferredEncryptedEnvValues()[0].key, 'SDR_SECRET');

		registerSecretDecryptor((value) => `decrypted:${value.slice(PREFIX.length)}`);
		assert.equal(process.env.SDR_SECRET, 'decrypted:abc');
		assert.equal(getDeferredEncryptedEnvValues().length, 0);
	});

	it('decrypts inline (no deferral) when a decryptor is already registered', () => {
		registerSecretDecryptor((value) => `decrypted:${value.slice(PREFIX.length)}`);
		handleApplication(fakeScope(`SDR_SECRET=${PREFIX}xyz`));
		assert.equal(process.env.SDR_SECRET, 'decrypted:xyz');
		assert.equal(getDeferredEncryptedEnvValues().length, 0);
	});

	it('logs and skips an entry that fails to decrypt during replay, still applying the rest', () => {
		deferEncryptedEnvValue({
			key: 'SDR_BAD',
			rawValue: `${PREFIX}bad`,
			sourcePath: '/apps/test/.env',
			override: false,
		});
		deferEncryptedEnvValue({
			key: 'SDR_GOOD',
			rawValue: `${PREFIX}good`,
			sourcePath: '/apps/test/.env',
			override: false,
		});
		registerSecretDecryptor((value) => {
			if (value.includes('bad')) throw new Error('cannot decrypt');
			return 'ok';
		});
		assert.equal(process.env.SDR_BAD, undefined);
		assert.equal(process.env.SDR_GOOD, 'ok');
		assert.equal(getDeferredEncryptedEnvValues().length, 0);
	});

	it('applies the same conflict/override semantics as the original load', () => {
		process.env.SDR_TAKEN = 'original';
		process.env.SDR_OVERRIDE = 'original';
		handleApplication(fakeScope(`SDR_TAKEN=${PREFIX}taken`));
		handleApplication(fakeScope(`SDR_OVERRIDE=${PREFIX}override`, { override: true }));
		assert.equal(getDeferredEncryptedEnvValues().length, 2);

		registerSecretDecryptor((value) => `decrypted:${value.slice(PREFIX.length)}`);
		// already-set key without override: kept
		assert.equal(process.env.SDR_TAKEN, 'original');
		// already-set key from an override-enabled env file: replaced
		assert.equal(process.env.SDR_OVERRIDE, 'decrypted:override');
	});

	it('caps the deferred queue defensively', () => {
		for (let i = 0; i < 1005; i++) {
			deferEncryptedEnvValue({ key: `SDR_CAP_${i}`, rawValue: `${PREFIX}v`, sourcePath: '/x/.env', override: false });
		}
		assert.equal(getDeferredEncryptedEnvValues().length, 1000);
		clearSecretDecryptor();
	});
});
