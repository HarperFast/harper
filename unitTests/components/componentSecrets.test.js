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
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { inspect } = require('node:util');
const {
	materializeGlobalSecrets,
	processComponentEnv,
	getSecretsForComponent,
	getUnsatisfiedEnv,
	runWithComponentBinding,
	secrets,
	resetComponentSecrets,
	closeComponentSubscriptions,
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

// Minimal mock table: rows keyed by name with the search() subset materialization uses, plus the
// get()/subscribe() surface the live change watcher (#1776) needs. `emit()` drives the captured
// subscription listener the way a committed put/delete would.
function installMockSecretTable() {
	const rows = new Map();
	let listener;
	const mock = {
		rows,
		subscribeCount: 0,
		// Optional async hook invoked between rows during a scan, so a test can inject a concurrent change
		// mid-scan (exercises the stale-rescan retry guard).
		scanHook: null,
		search() {
			// Stable snapshot at scan start, like a real table.search — a mid-scan mutation to `rows` is
			// NOT reflected in this scan's yields.
			const snapshot = [...rows.values()];
			const hook = mock.scanHook;
			return (async function* () {
				for (const record of snapshot) {
					yield record;
					if (hook) await hook();
				}
			})();
		},
		async get(name) {
			return rows.get(name) ?? null;
		},
		async subscribe(request) {
			mock.subscribeCount++;
			listener = request?.listener;
			return {
				emit() {},
				end() {
					if (listener === request?.listener) listener = undefined;
				},
			};
		},
		// Simulate a committed change to `name`: `record === null` is a delete.
		emit(name, record) {
			if (record) rows.set(name, record);
			else rows.delete(name);
			listener?.({ id: name, type: record ? 'put' : 'delete', value: record ?? null });
		},
		// Simulate a base-copy reload marker (the whole table was reseeded; no per-row events).
		emitReload() {
			listener?.({ id: null, type: 'reload', value: null });
		},
		// Simulate Table.subscribe surfacing an async replay failure through the listener.
		emitError(error) {
			listener?.(error);
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

// Scoped-tier row (accessor-only, restricted to `grants`).
function row(name, plaintext, grants = []) {
	return { name, envelope: seal(plaintext), kid: fp, grants };
}

// process.env-tier row (materialized into the real process.env for every component).
function envRow(name, plaintext) {
	return { name, envelope: seal(plaintext), kid: fp, grants: [], processEnv: true };
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
		it('materializes processEnv rows into the real process.env', async () => {
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'g-value'));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_GLOBAL, 'g-value');
		});

		it('a pre-existing real environment variable wins over the store', async () => {
			process.env.CS_PRESET = 'from-real-env';
			table.mock.rows.set('CS_PRESET', envRow('CS_PRESET', 'from-store'));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_PRESET, 'from-real-env');
		});

		it('scoped rows (grants, no processEnv) NEVER land in process.env', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 's-value', ['some-app']));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_SCOPED, undefined);
		});

		it('an un-flagged row (no processEnv, no grants) is inert — not in process.env', async () => {
			table.mock.rows.set('CS_GLOBAL', row('CS_GLOBAL', 'v1'));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_GLOBAL, undefined);
		});

		it('re-materialization updates a value this module owns (reload heals)', async () => {
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'v1'));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_GLOBAL, 'v1');
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'v2'));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_GLOBAL, 'v2');
		});

		it('retracts an owned value when the row is deleted', async () => {
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'v1'));
			await materializeGlobalSecrets();
			table.mock.rows.delete('CS_GLOBAL');
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_GLOBAL, undefined);
		});

		it('retracts an owned value when the row is converted from processEnv to scoped', async () => {
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'v1'));
			await materializeGlobalSecrets();
			table.mock.rows.set('CS_GLOBAL', row('CS_GLOBAL', 'v1', ['some-app']));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_GLOBAL, undefined);
		});

		it('no custody registered: nothing materialized, no throw (degraded)', async () => {
			clearSecretCustody();
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'v1'));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_GLOBAL, undefined);
		});

		it('secrets table missing (pre-upgrade): no throw (degraded)', async () => {
			table.restore();
			delete databases.system[SECRET_TABLE];
			await materializeGlobalSecrets();
		});

		it('reprocessing a component env block overwrites its previous declaration state', async () => {
			await materializeGlobalSecrets();
			processComponentEnv('app-a', { CS_OPT: { required: false } });
			assert.equal(getUnsatisfiedEnv('app-a').length, 1);
			// the component is redeployed/reprocessed with the declaration removed
			await materializeGlobalSecrets();
			processComponentEnv('app-a', {});
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
			table.mock.rows.set('CS_REQ', envRow('CS_REQ', 'v'));
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
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'v'));
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

		it('a granted-but-undecryptable row falls back to a real env var (gate matches the accessor)', async () => {
			process.env.CS_REQ = 'env-fallback';
			table.mock.rows.set('CS_REQ', row('CS_REQ', 'sealed', ['app-a']));
			clearSecretCustody();
			await materializeGlobalSecrets();
			processComponentEnv('app-a', { CS_REQ: { required: true } });
			assert.equal(getUnsatisfiedEnv('app-a').length, 0);
			assert.equal(getSecretsForComponent('app-a').CS_REQ, 'env-fallback');
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
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'g-value'));
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 's-value', ['app-a']));
			await materializeGlobalSecrets();
			processComponentEnv('app-a', { CS_GLOBAL: { required: true } });
			const view = getSecretsForComponent('app-a');
			assert.equal(view.CS_GLOBAL, 'g-value');
			assert.equal(view.CS_SCOPED, 's-value');
		});

		it('undeclared global-tier names are not in the view (env is not mirrored wholesale)', async () => {
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'g-value'));
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
			// The live view is read-only (a Proxy, not a frozen object — frozen would preclude live values).
			assert.throws(() => {
				view.CS_SCOPED = 'nope';
			}, TypeError);
			assert.throws(() => {
				delete view.CS_SCOPED;
			}, TypeError);
		});

		it('a granted scoped row wins over an env var of the same name', async () => {
			process.env.CS_COLLIDE = 'env-value';
			table.mock.rows.set('CS_COLLIDE', row('CS_COLLIDE', 'scoped-value', ['app-a']));
			await materializeGlobalSecrets();
			processComponentEnv('app-a', { CS_COLLIDE: { required: true } });
			assert.equal(getSecretsForComponent('app-a').CS_COLLIDE, 'scoped-value');
		});

		it('has a null prototype: Object.prototype names never masquerade as secrets', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 's-value', ['app-a']));
			await materializeGlobalSecrets();
			const view = getSecretsForComponent('app-a');
			assert.equal(Object.getPrototypeOf(view), null);
			assert.equal(view.toString, undefined);
			assert.equal(view.hasOwnProperty, undefined);
			assert.equal(view.constructor, undefined);
		});
	});

	describe('materialization single-flight', () => {
		it('concurrent callers share one table scan; sequential callers get fresh scans', async () => {
			let scans = 0;
			const baseSearch = table.mock.search.bind(table.mock);
			table.mock.search = () => {
				scans++;
				return (async function* () {
					await new Promise((resolve) => setImmediate(resolve)); // widen the concurrency window
					yield* baseSearch();
				})();
			};
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'v1'));
			await Promise.all([materializeGlobalSecrets(), materializeGlobalSecrets(), materializeGlobalSecrets()]);
			assert.equal(scans, 1);
			assert.equal(process.env.CS_GLOBAL, 'v1');
			// after completion a new call must re-read (freshness for set_secret → deploy)
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'v2'));
			await materializeGlobalSecrets();
			assert.equal(scans, 2);
			assert.equal(process.env.CS_GLOBAL, 'v2');
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

		it('fails loudly on direct reads outside a component-load context', () => {
			assert.throws(() => secrets.CS_SCOPED, /outside of a component-loading context/);
		});

		it('enumeration reports an empty object outside a component-load context (inspect-safe)', () => {
			// Inspectors/serializers hit these traps (util.inspect, spread, `in`) — they must never
			// crash the process; only direct property reads are loud.
			assert.deepEqual(Object.keys(secrets), []);
			assert.equal('CS_SCOPED' in secrets, false);
			assert.equal(Object.getOwnPropertyDescriptor(secrets, 'CS_SCOPED'), undefined);
			assert.deepEqual({ ...secrets }, {});
			assert.doesNotThrow(() => inspect(secrets));
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

		// Regression guard for the native-loader path: the binding set by runWithComponentBinding
		// (what scopedImport does around `await import(moduleUrl)`) must survive into the ESM
		// module's TOP-LEVEL evaluation — including the recommended `const { X } = secrets;`
		// destructure and code after a top-level await. AsyncLocalStorage propagation into
		// dynamic-import evaluation has version-dependent history, so this is asserted empirically
		// on every supported Node version rather than assumed.
		it('propagates the binding into native-loader ESM top-level evaluation', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 's-value', ['app-native']));
			await materializeGlobalSecrets();
			const dir = mkdtempSync(path.join(tmpdir(), 'cs-native-'));
			const modPath = path.join(dir, 'entry.mjs');
			// require()ing the module from the temp file hits the same CJS cache entry as this test's
			// own require — the same `secrets` proxy instance a native-loader component would get.
			const componentSecretsPath = require.resolve('#src/components/componentSecrets');
			writeFileSync(
				modPath,
				`import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { secrets } = require(${JSON.stringify(componentSecretsPath)});
export const topLevel = secrets.CS_SCOPED;
const { CS_SCOPED } = secrets;
export const destructured = CS_SCOPED;
await new Promise((resolve) => setImmediate(resolve));
export const afterTopLevelAwait = secrets.CS_SCOPED;
`
			);
			try {
				const mod = await runWithComponentBinding('app-native', () => import(pathToFileURL(modPath).toString()));
				assert.equal(mod.topLevel, 's-value');
				assert.equal(mod.destructured, 's-value');
				assert.equal(mod.afterTopLevelAwait, 's-value');
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
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

	describe('live change subscription (secrets.subscribe, #1776)', () => {
		// The initial value is served synchronously from the live snapshot, so tests seed it via
		// materializeGlobalSecrets() (which also starts the watcher on the mock).
		it('yields the current value then each subsequent change for a granted scoped secret', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			const iter = getSecretsForComponent('app').subscribe('CS_SCOPED');
			assert.equal((await iter.next()).value, 'v1'); // current value first
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v2', ['app']));
			assert.equal((await iter.next()).value, 'v2');
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v3', ['app']));
			assert.equal((await iter.next()).value, 'v3');
			await iter.return();
		});

		it('yields undefined (not a close) when the grant is revoked, and resumes on re-grant', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			const iter = getSecretsForComponent('app').subscribe('CS_SCOPED');
			assert.equal((await iter.next()).value, 'v1');
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v1', [])); // grant removed → access lost
			const revoked = await iter.next();
			assert.equal(revoked.done, false); // stream stays open
			assert.equal(revoked.value, undefined); // value is now absent
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v2', ['app'])); // re-granted with a new value
			assert.equal((await iter.next()).value, 'v2'); // same iterator, no re-subscribe
			await iter.return();
		});

		it('yields undefined on delete and resumes with the new value on re-add (no restart)', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			const iter = getSecretsForComponent('app').subscribe('CS_SCOPED');
			assert.equal((await iter.next()).value, 'v1');
			table.mock.emit('CS_SCOPED', null); // deleted
			assert.equal((await iter.next()).value, undefined);
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v2', ['app'])); // re-added
			assert.equal((await iter.next()).value, 'v2');
			await iter.return();
		});

		it('yields undefined up front for a secret the component cannot currently read', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['other-app']));
			await materializeGlobalSecrets();
			const iter = getSecretsForComponent('app').subscribe('CS_SCOPED');
			const first = await iter.next();
			assert.equal(first.done, false);
			assert.equal(first.value, undefined);
			await iter.return();
		});

		it('does not re-emit an unchanged value', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			const iter = getSecretsForComponent('app').subscribe('CS_SCOPED');
			assert.equal((await iter.next()).value, 'v1');
			const pending = iter.next();
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v1', ['app'])); // same value → suppressed
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v2', ['app'])); // real change
			assert.equal((await pending).value, 'v2'); // never saw a duplicate v1
			await iter.return();
		});

		it('never widens access: silent (undefined) until this component is granted, then resumes', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['other-app']));
			await materializeGlobalSecrets();
			const iter = getSecretsForComponent('app').subscribe('CS_SCOPED');
			assert.equal((await iter.next()).value, undefined); // not granted to app → no value
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v2', ['other-app'])); // change for another app only
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v2', ['other-app', 'app'])); // now granted to app
			assert.equal((await iter.next()).value, 'v2'); // the change for another app was never delivered
			await iter.return();
		});

		it('does not leak a globally-materialized value to an undeclared, ungranted component', async () => {
			// CS_GLOBAL is materialized into process.env, but app-b neither declares nor is granted it.
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'g1'));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_GLOBAL, 'g1'); // present in process.env
			const iter = getSecretsForComponent('app-b').subscribe('CS_GLOBAL');
			assert.equal((await iter.next()).value, undefined); // not visible to app-b (no ungated env fallback)
			await iter.return();
		});

		it('drops a queued value on revoke (no stale plaintext delivered after access loss)', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			const iter = getSecretsForComponent('app').subscribe('CS_SCOPED');
			assert.equal((await iter.next()).value, 'v1');
			// No consumer parked: v2 is queued, then a revoke coalesces over it before it is read.
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v2', ['app'])); // queued
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v2', [])); // revoked before consume
			assert.equal((await iter.next()).value, undefined); // stale v2 dropped; only the revoke is seen
			await iter.return();
		});

		it('does not expose a queued value after the stream is closed', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			const iter = getSecretsForComponent('app').subscribe('CS_SCOPED');
			assert.equal((await iter.next()).value, 'v1');
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v2', ['app'])); // queued, no waiter
			await iter.return(); // close: drops the queued plaintext
			assert.equal((await iter.next()).done, true); // not v2
		});

		it('settles concurrent next() calls independently', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			const iter = getSecretsForComponent('app').subscribe('CS_SCOPED');
			assert.equal((await iter.next()).value, 'v1');
			const a = iter.next();
			const b = iter.next(); // second concurrent waiter must not orphan the first
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v2', ['app']));
			assert.equal((await a).value, 'v2'); // first waiter settles (would hang if overwritten)
			await iter.return(); // closes; remaining waiter settles as done
			assert.equal((await b).done, true);
		});

		it('delivers a declared global secret from process.env (reload-only tier)', async () => {
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'g1'));
			await materializeGlobalSecrets();
			processComponentEnv('app', { CS_GLOBAL: { required: true } });
			const iter = getSecretsForComponent('app').subscribe('CS_GLOBAL');
			assert.equal((await iter.next()).value, 'g1'); // current process.env value
			table.mock.emit('CS_GLOBAL', envRow('CS_GLOBAL', 'g2'));
			assert.equal(process.env.CS_GLOBAL, 'g1'); // global tier is not re-mutated live
			await iter.return();
		});

		it('exposes subscribe as a reserved, non-enumerable method on the view and the proxy', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			const view = getSecretsForComponent('app');
			assert.equal(typeof view.subscribe, 'function');
			assert.ok(!Object.keys(view).includes('subscribe')); // skipped by Object.keys/spread
			assert.equal(Object.getOwnPropertyDescriptor(view, 'subscribe').enumerable, false);
			await runWithComponentBinding('app', () => {
				assert.equal(typeof secrets.subscribe, 'function');
				assert.deepEqual(Object.keys(secrets), ['CS_SCOPED']); // subscribe not enumerated
			});
		});

		it('with no store, still delivers a declared process.env value (accessor-equivalent)', async () => {
			table.restore();
			delete databases.system[SECRET_TABLE];
			process.env.CS_DECLARED = 'from-env';
			processComponentEnv('app', { CS_DECLARED: { required: false } });
			const iter = getSecretsForComponent('app').subscribe('CS_DECLARED');
			assert.equal((await iter.next()).value, 'from-env'); // readable even with no store
			await iter.return();
		});

		it('closeComponentSubscriptions ends the streams a component opened', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			const iter = getSecretsForComponent('app').subscribe('CS_SCOPED');
			assert.equal((await iter.next()).value, 'v1');
			closeComponentSubscriptions('other-app'); // unrelated component: no effect
			const stillPending = iter.next();
			closeComponentSubscriptions('app');
			assert.equal((await stillPending).done, true);
		});
	});

	describe('live accessor (scoped tier reflects changes without reload, #1776)', () => {
		it('a scoped secret value change is reflected by a fresh secrets read', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets(); // seeds the snapshot and starts the watcher
			assert.equal(getSecretsForComponent('app').CS_SCOPED, 'v1');
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v2', ['app']));
			assert.equal(getSecretsForComponent('app').CS_SCOPED, 'v2'); // live, no reload
		});

		it('is live through the context-bound process-wide secrets proxy too', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			await runWithComponentBinding('app', async () => {
				assert.equal(secrets.CS_SCOPED, 'v1');
				table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v2', ['app']));
				assert.equal(secrets.CS_SCOPED, 'v2');
			});
		});

		it('a revoked grant removes the value from the accessor; a re-grant restores it', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			assert.equal(getSecretsForComponent('app').CS_SCOPED, 'v1');
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v1', [])); // revoked
			assert.equal(getSecretsForComponent('app').CS_SCOPED, undefined);
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v1', ['app'])); // re-granted
			assert.equal(getSecretsForComponent('app').CS_SCOPED, 'v1');
		});

		it('a global (processEnv) secret change stays reload-only in the accessor and process.env', async () => {
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'g1'));
			await materializeGlobalSecrets();
			processComponentEnv('app', { CS_GLOBAL: { required: true } });
			assert.equal(getSecretsForComponent('app').CS_GLOBAL, 'g1');
			table.mock.emit('CS_GLOBAL', envRow('CS_GLOBAL', 'g2'));
			assert.equal(getSecretsForComponent('app').CS_GLOBAL, 'g1'); // unchanged until reload
			assert.equal(process.env.CS_GLOBAL, 'g1');
		});

		it('a retained view reference reflects live changes (Proxy, not a captured snapshot)', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			const view = getSecretsForComponent('app'); // capture once (mirrors vm/compartment injection)
			assert.equal(view.CS_SCOPED, 'v1');
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v2', ['app']));
			assert.equal(view.CS_SCOPED, 'v2'); // same object, live
		});

		it('re-scans on a base-copy reload marker (imports new rows, drops removed ones)', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			table.mock.rows.set('CS_GLOBAL', row('CS_GLOBAL', 'gone', ['app']));
			await materializeGlobalSecrets();
			assert.equal(getSecretsForComponent('app').CS_SCOPED, 'v1');
			// Base copy reseeds the table wholesale and emits only a reload marker (no per-row events).
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v2', ['app']));
			table.mock.rows.delete('CS_GLOBAL');
			table.mock.emitReload();
			await new Promise((resolve) => setImmediate(resolve)); // the re-scan is async
			assert.equal(getSecretsForComponent('app').CS_SCOPED, 'v2'); // updated
			assert.equal(getSecretsForComponent('app').CS_GLOBAL, undefined); // removed
		});
	});

	describe('hardening (review findings, #1776)', () => {
		it('a stale rescan cannot re-authorize a secret revoked while it ran', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			assert.equal(getSecretsForComponent('app').CS_SCOPED, 'v1');
			// Revoke the grant mid-scan: the scan's stable snapshot still shows it granted, but the retry
			// guard must re-scan and end up with the revoked state rather than clobbering the live update.
			table.mock.scanHook = async () => {
				table.mock.scanHook = null; // fire once
				table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v1', [])); // revoke lands during the scan
			};
			await materializeGlobalSecrets();
			assert.equal(getSecretsForComponent('app').CS_SCOPED, undefined); // NOT re-authorized
		});

		it('a secret named "subscribe" is not readable via the accessor or subscribe (reserved)', async () => {
			table.mock.rows.set('subscribe', row('subscribe', 'plaintext', ['app']));
			await materializeGlobalSecrets();
			const view = getSecretsForComponent('app');
			assert.equal(typeof view.subscribe, 'function'); // the reserved method, not the value
			assert.ok(!Object.keys(view).includes('subscribe'));
			const iter = view.subscribe('subscribe');
			assert.equal((await iter.next()).value, undefined); // never leaks the plaintext
			await iter.return();
		});

		it('subscribe is an own, non-enumerable key (consistent reflection)', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			const view = getSecretsForComponent('app');
			assert.ok(Reflect.ownKeys(view).includes('subscribe')); // present for reflection
			assert.ok(Object.hasOwn(view, 'subscribe'));
			assert.ok(!Object.keys(view).includes('subscribe')); // but non-enumerable
		});

		it('a reload marker re-delivers undefined to a subscriber whose secret was removed', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			const iter = getSecretsForComponent('app').subscribe('CS_SCOPED');
			assert.equal((await iter.next()).value, 'v1');
			table.mock.rows.delete('CS_SCOPED'); // base copy removed it
			table.mock.emitReload();
			assert.equal((await iter.next()).value, undefined); // stream re-dispatched, not left stale
			await iter.return();
		});

		it('a reload marker does not re-materialize the global tier into process.env', async () => {
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'g1'));
			await materializeGlobalSecrets();
			assert.equal(process.env.CS_GLOBAL, 'g1');
			table.mock.rows.set('CS_GLOBAL', envRow('CS_GLOBAL', 'g2')); // changed at the source
			table.mock.emitReload();
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(process.env.CS_GLOBAL, 'g1'); // reload-only: not re-mutated under running code
		});

		it('restarts the watcher when the subscription surfaces an error through the listener', async () => {
			table.mock.rows.set('CS_SCOPED', row('CS_SCOPED', 'v1', ['app']));
			await materializeGlobalSecrets();
			const before = table.mock.subscribeCount;
			table.mock.emitError(new Error('replay failed')); // resets the watcher memo
			const iter = getSecretsForComponent('app').subscribe('CS_SCOPED');
			assert.equal((await iter.next()).value, 'v1'); // initial from the snapshot
			await new Promise((resolve) => setImmediate(resolve)); // let ensureSecretWatcher re-attach
			assert.ok(table.mock.subscribeCount > before, 're-subscribed after the error');
			table.mock.emit('CS_SCOPED', row('CS_SCOPED', 'v2', ['app'])); // live changes flow again
			assert.equal((await iter.next()).value, 'v2');
			await iter.return();
		});
	});
});
