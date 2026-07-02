'use strict';

// Tests for components/componentSecrets.ts — the consumption side of the hdb_secret store
// (#1550): global-tier materialization into process.env, `env:` block parsing (literals +
// declarations), the required-declaration load-gate, the per-component secrets accessor, and the
// context-bound process-wide `secrets` export. Follows the secretOperations.test.js pattern: a
// Map-backed mock table on databases.system plus a real in-memory RSA keypair as custody — no
// stubs.

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { generateKeyPairSync } = require('node:crypto');
const {
	materializeGlobalSecrets,
	processComponentEnv,
	getSecretsForComponent,
	getUnsatisfiedEnv,
	runWithComponentBinding,
	secrets,
	resetComponentSecrets,
} = require('#src/components/componentSecrets');
const { databases } = require('#src/resources/databases');
const terms = require('#src/utility/hdbTerms');
const { registerSecretCustody, clearSecretCustody } = require('#src/resources/secretDecryptor');
const { fingerprintOf, encryptEnvelope, decryptEnvelope } = require('#src/utility/secretEnvelope');

const SECRET_TABLE = terms.SYSTEM_TABLE_NAMES.SECRET_TABLE_NAME;
const PREFIX = 'enc:v1:';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const fp = fingerprintOf(publicKey);

function installCustody() {
	registerSecretCustody({
		decrypt: (value) => decryptEnvelope(value.slice(PREFIX.length), privateKey, fp),
		getPublicKey: () => ({ publicKey, fingerprint: fp }),
	});
}

function seal(plaintext) {
	return PREFIX + encryptEnvelope(plaintext, publicKey, fp);
}

// Minimal mock table: rows keyed by name with the search() subset materialization uses.
function installMockSecretTable() {
	const rows = new Map();
	const mock = {
		rows,
		search() {
			return (async function* () {
				yield* rows.values();
			})();
		},
	};
	if (!databases.system) databases.system = {};
	const prior = databases.system[SECRET_TABLE];
	databases.system[SECRET_TABLE] = mock;
	return {
		mock,
		restore() {
			if (databases.system) databases.system[SECRET_TABLE] = prior;
		},
	};
}

function row(name, plaintext, grants = []) {
	return { name, envelope: seal(plaintext), kid: fp, grants };
}

describe('componentSecrets', () => {
	let table;
	// Every env key a test may touch, cleaned after each test.
	const ENV_KEYS = [
		'CS_GLOBAL',
		'CS_GLOBAL2',
		'CS_PRESET',
		'CS_SCOPED',
		'CS_LITERAL',
		'CS_LITERAL_NUM',
		'CS_LITERAL_ENC',
		'CS_DECLARED',
		'CS_REQ',
		'CS_OPT',
		'CS_COLLIDE',
	];
	const savedEnv = new Map();

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			savedEnv.set(key, process.env[key]);
			delete process.env[key];
		}
		table = installMockSecretTable();
		installCustody();
	});

	afterEach(() => {
		resetComponentSecrets();
		clearSecretCustody();
		table.restore();
		for (const key of ENV_KEYS) {
			const prior = savedEnv.get(key);
			if (prior === undefined) delete process.env[key];
			else process.env[key] = prior;
		}
	});

	describe('global-tier materialization', () => {
		it('materializes empty-grants rows into the real process.env', async () => {
			table.mock.rows.set('CS_GLOBAL', row('CS_GLOBAL', 'g-value'));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_GLOBAL, 'g-value');
		});

		it('a pre-existing real environment variable wins over the store', async () => {
			process.env.CS_PRESET = 'from-real-env';
			table.mock.rows.set('CS_PRESET', row('CS_PRESET', 'from-store'));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_PRESET, 'from-real-env');
		});

		it('rows with non-empty grants NEVER land in process.env', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 's-value', ['some-app']));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_SCOPED, undefined);
		});

		it('re-materialization updates a value this module owns (reload heals)', async () => {
			table.mock.rows.set('CS_GLOBAL', row('CS_GLOBAL', 'v1'));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_GLOBAL, 'v1');
			table.mock.rows.set('CS_GLOBAL', row('CS_GLOBAL', 'v2'));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_GLOBAL, 'v2');
		});

		it('retracts an owned value when the row is deleted', async () => {
			table.mock.rows.set('CS_GLOBAL', row('CS_GLOBAL', 'v1'));
			await materializeGlobalSecrets();
			table.mock.rows.delete('CS_GLOBAL');
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_GLOBAL, undefined);
		});

		it('retracts an owned value when grants are tightened to scoped', async () => {
			table.mock.rows.set('CS_GLOBAL', row('CS_GLOBAL', 'v1'));
			await materializeGlobalSecrets();
			table.mock.rows.set('CS_GLOBAL', row('CS_GLOBAL', 'v1', ['some-app']));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_GLOBAL, undefined);
		});

		it('no custody registered: nothing materialized, no throw (degraded)', async () => {
			clearSecretCustody();
			table.mock.rows.set('CS_GLOBAL', row('CS_GLOBAL', 'v1'));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_GLOBAL, undefined);
		});

		it('secrets table missing (pre-upgrade): no throw (degraded)', async () => {
			table.restore();
			delete databases.system[SECRET_TABLE];
			await materializeGlobalSecrets();
		});

		it('resetDeclarations drops per-component state from removed env blocks', async () => {
			await materializeGlobalSecrets();
			processComponentEnv('app-a', { CS_OPT: { required: false } });
			assert.equal(getUnsatisfiedEnv('app-a').length, 1);
			// next load cycle: the component no longer declares anything
			await materializeGlobalSecrets({ resetDeclarations: true });
			assert.equal(getUnsatisfiedEnv('app-a').length, 0);
			assert.deepEqual(Object.keys(getSecretsForComponent('app-a')), []);
		});
	});

	describe('env block: literals', () => {
		it('injects a string literal into process.env', () => {
			processComponentEnv('app-a', { CS_LITERAL: 'plain-value' });
			assert.equal(process.env.CS_LITERAL, 'plain-value');
		});

		it('coerces YAML scalars (numbers/booleans) to strings', () => {
			processComponentEnv('app-a', { CS_LITERAL_NUM: 3000 });
			assert.equal(process.env.CS_LITERAL_NUM, '3000');
		});

		it('decrypts enc:v1: literals via the registered decryptor (same as a .env line)', () => {
			processComponentEnv('app-a', { CS_LITERAL_ENC: seal('literal-secret') });
			assert.equal(process.env.CS_LITERAL_ENC, 'literal-secret');
		});

		it('skips an enc:v1: literal (never exposes ciphertext) when no decryptor is registered', () => {
			const envelope = seal('literal-secret');
			clearSecretCustody();
			processComponentEnv('app-a', { CS_LITERAL_ENC: envelope });
			assert.equal(process.env.CS_LITERAL_ENC, undefined);
		});

		it('a pre-existing env value wins over a literal', () => {
			process.env.CS_LITERAL = 'pre-existing';
			processComponentEnv('app-a', { CS_LITERAL: 'from-config' });
			assert.equal(process.env.CS_LITERAL, 'pre-existing');
		});

		it('a failed load-gate applies none of the block literals', () => {
			assert.throws(() => processComponentEnv('app-a', { CS_LITERAL: 'lit', CS_REQ: { required: true } }));
			assert.equal(process.env.CS_LITERAL, undefined);
		});

		it('an invalid declaration shape applies none of the block literals', () => {
			assert.throws(() => processComponentEnv('app-a', { CS_LITERAL: 'lit', CS_REQ: { required: 'yes' } }));
			assert.equal(process.env.CS_LITERAL, undefined);
		});
	});

	describe('env block: declaration parsing', () => {
		it('rejects a non-mapping env block', () => {
			assert.throws(() => processComponentEnv('app-a', ['CS_REQ']), /must be a mapping/);
			assert.throws(() => processComponentEnv('app-a', 'CS_REQ'), /must be a mapping/);
		});

		it('rejects invalid declaration shapes', () => {
			assert.throws(() => processComponentEnv('app-a', { CS_REQ: ['x'] }), /string literal or a declaration object/);
			assert.throws(
				() => processComponentEnv('app-a', { CS_REQ: { required: 'yes' } }),
				/'required' must be a boolean/
			);
			assert.throws(
				() => processComponentEnv('app-a', { CS_REQ: { description: 5 } }),
				/'description' must be a string/
			);
		});

		it('treats a bare null value as an optional declaration', () => {
			processComponentEnv('app-a', { CS_OPT: null });
			const unsatisfied = getUnsatisfiedEnv('app-a');
			assert.equal(unsatisfied.length, 1);
			assert.equal(unsatisfied[0].name, 'CS_OPT');
			assert.equal(unsatisfied[0].required, false);
			assert.equal(unsatisfied[0].reason, 'missing');
		});
	});

	describe('load-gate on required declarations', () => {
		it('missing: no row, no env var', async () => {
			await materializeGlobalSecrets();
			assert.throws(
				() => processComponentEnv('app-a', { CS_REQ: { required: true, description: 'a key' } }),
				(error) =>
					/unsatisfied required environment variables/.test(error.message) && /CS_REQ \(missing/.test(error.message)
			);
			const unsatisfied = getUnsatisfiedEnv('app-a');
			assert.equal(unsatisfied[0].reason, 'missing');
			assert.equal(unsatisfied[0].description, 'a key');
			assert.equal(unsatisfied[0].required, true);
		});

		it('ungranted: a scoped row exists but for another component', async () => {
			table.mock.rows.set('CS_REQ', row('CS_REQ', 'super-secret-plaintext', ['other-app']));
			await materializeGlobalSecrets();
			assert.throws(() => processComponentEnv('app-a', { CS_REQ: { required: true } }), /CS_REQ \(ungranted/);
			const unsatisfied = getUnsatisfiedEnv('app-a');
			assert.equal(unsatisfied[0].reason, 'ungranted');
			assert.equal(unsatisfied[0].tier, 'scoped');
			// metadata only — never values
			assert.equal(JSON.stringify(unsatisfied).includes('super-secret-plaintext'), false);
		});

		it('custody-unavailable: row exists but cannot be decrypted on this node', async () => {
			table.mock.rows.set('CS_REQ', row('CS_REQ', 'v'));
			clearSecretCustody();
			await materializeGlobalSecrets();
			assert.throws(() => processComponentEnv('app-a', { CS_REQ: { required: true } }), /CS_REQ \(custody-unavailable/);
			assert.equal(getUnsatisfiedEnv('app-a')[0].reason, 'custody-unavailable');
			assert.equal(getUnsatisfiedEnv('app-a')[0].tier, 'global');
		});

		it('names every failed variable in one error', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v', ['other-app']));
			await materializeGlobalSecrets();
			assert.throws(
				() => processComponentEnv('app-a', { CS_REQ: { required: true }, CS_SCOPED: { required: true } }),
				(error) => /CS_REQ \(missing/.test(error.message) && /CS_SCOPED \(ungranted/.test(error.message)
			);
		});

		it('satisfied via a granted scoped row', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v', ['app-a']));
			await materializeGlobalSecrets();
			processComponentEnv('app-a', { CS_SCOPED: { required: true } });
			assert.equal(getUnsatisfiedEnv('app-a').length, 0);
		});

		it('satisfied via a materialized global-tier row', async () => {
			table.mock.rows.set('CS_GLOBAL', row('CS_GLOBAL', 'v'));
			await materializeGlobalSecrets();
			processComponentEnv('app-a', { CS_GLOBAL: { required: true } });
			assert.equal(getUnsatisfiedEnv('app-a').length, 0);
		});

		it('satisfied via a real environment variable', async () => {
			process.env.CS_REQ = 'real';
			await materializeGlobalSecrets();
			processComponentEnv('app-a', { CS_REQ: { required: true } });
			assert.equal(getUnsatisfiedEnv('app-a').length, 0);
		});

		it('optional unsatisfied declarations do not gate, but are recorded', async () => {
			await materializeGlobalSecrets();
			processComponentEnv('app-a', { CS_OPT: { required: false, description: 'nice to have' } });
			const unsatisfied = getUnsatisfiedEnv('app-a');
			assert.equal(unsatisfied.length, 1);
			assert.deepEqual(Object.keys(unsatisfied[0]).sort(), [
				'description',
				'detail',
				'name',
				'reason',
				'required',
				'tier',
			]);
		});
	});

	describe('per-component secrets accessor', () => {
		it('exposes scoped rows to the granted component only', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 's-value', ['app-a']));
			await materializeGlobalSecrets();
			assert.equal(getSecretsForComponent('app-a').CS_SCOPED, 's-value');
			assert.equal(getSecretsForComponent('app-b').CS_SCOPED, undefined);
		});

		it('superset view includes declared global-tier names', async () => {
			table.mock.rows.set('CS_GLOBAL', row('CS_GLOBAL', 'g-value'));
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 's-value', ['app-a']));
			await materializeGlobalSecrets();
			processComponentEnv('app-a', { CS_GLOBAL: { required: true } });
			const view = getSecretsForComponent('app-a');
			assert.equal(view.CS_GLOBAL, 'g-value');
			assert.equal(view.CS_SCOPED, 's-value');
		});

		it('undeclared global-tier names are not in the view (env is not mirrored wholesale)', async () => {
			table.mock.rows.set('CS_GLOBAL', row('CS_GLOBAL', 'g-value'));
			await materializeGlobalSecrets();
			assert.equal(getSecretsForComponent('app-a').CS_GLOBAL, undefined);
			assert.equal(process.env.CS_GLOBAL, 'g-value');
		});

		it('supports enumeration: Object.keys and spread', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 's-value', ['app-a']));
			await materializeGlobalSecrets();
			processComponentEnv('app-a', { CS_LITERAL: 'lit' });
			// literals are not declarations, so only the scoped row is in the view
			const view = getSecretsForComponent('app-a');
			assert.deepEqual(Object.keys(view), ['CS_SCOPED']);
			assert.deepEqual({ ...view }, { CS_SCOPED: 's-value' });
			assert.equal(Object.isFrozen(view), true);
		});

		it('a granted scoped row wins over an env var of the same name', async () => {
			process.env.CS_COLLIDE = 'env-value';
			table.mock.rows.set('CS_COLLIDE', row('CS_COLLIDE', 'scoped-value', ['app-a']));
			await materializeGlobalSecrets();
			processComponentEnv('app-a', { CS_COLLIDE: { required: true } });
			assert.equal(getSecretsForComponent('app-a').CS_COLLIDE, 'scoped-value');
		});
	});

	describe('process-wide secrets export (component-load binding)', () => {
		it('resolves within a component-load binding, including across await', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 's-value', ['app-a']));
			await materializeGlobalSecrets();
			await runWithComponentBinding('app-a', async () => {
				assert.equal(secrets.CS_SCOPED, 's-value');
				assert.equal('CS_SCOPED' in secrets, true);
				assert.deepEqual(Object.keys(secrets), ['CS_SCOPED']);
				await new Promise((resolve) => setImmediate(resolve));
				const { CS_SCOPED } = secrets; // the recommended top-level-destructure idiom
				assert.equal(CS_SCOPED, 's-value');
			});
		});

		it('binds each concurrent component load to its own view', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'for-a', ['app-a']));
			table.mock.rows.set('CS_SCOPED2', row('CS_SCOPED2', 'for-b', ['app-b']));
			await materializeGlobalSecrets();
			await Promise.all([
				runWithComponentBinding('app-a', async () => {
					await new Promise((resolve) => setImmediate(resolve));
					assert.equal(secrets.CS_SCOPED, 'for-a');
					assert.equal(secrets.CS_SCOPED2, undefined);
				}),
				runWithComponentBinding('app-b', async () => {
					assert.equal(secrets.CS_SCOPED2, 'for-b');
					assert.equal(secrets.CS_SCOPED, undefined);
				}),
			]);
		});

		it('fails loudly outside a component-load context', () => {
			assert.throws(() => secrets.CS_SCOPED, /outside of a component-loading context/);
			assert.throws(() => Object.keys(secrets), /outside of a component-loading context/);
			assert.throws(() => 'CS_SCOPED' in secrets, /outside of a component-loading context/);
		});

		it('symbol and then probes do not throw (await/inspect interop)', async () => {
			assert.equal(secrets[Symbol.toStringTag], undefined);
			assert.equal(secrets.then, undefined);
			assert.equal(await secrets, secrets); // awaiting must not explode
		});

		it('is read-only', () => {
			assert.throws(() => {
				secrets.CS_SCOPED = 'nope';
			}, TypeError);
		});

		it('cannot be frozen/made non-extensible (which would poison enumeration for all consumers)', async () => {
			assert.throws(() => Object.freeze(secrets), TypeError);
			assert.throws(() => Object.preventExtensions(secrets), TypeError);
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 's-value', ['app-a']));
			await materializeGlobalSecrets();
			await runWithComponentBinding('app-a', async () => {
				assert.deepEqual(Object.keys(secrets), ['CS_SCOPED']); // still enumerable afterward
			});
		});
	});
});
