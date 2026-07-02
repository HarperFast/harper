'use strict';

// Op-flow tests for the hdb_secret operations (components/secretOperations.ts), following the
// deploymentRecorder.test.js pattern: a Map-backed mock table on databases.system, plus a real
// in-memory RSA keypair registered as secret custody so encrypt/decrypt-verify paths are
// exercised end-to-end without stubs.

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { generateKeyPairSync } = require('node:crypto');
const secretOps = require('#src/components/secretOperations');
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

// A second, unrelated keypair for wrong-key / stale-kid scenarios.
const other = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const otherFp = fingerprintOf(other.publicKey);

function installCustody() {
	registerSecretCustody({
		decrypt: (value) => decryptEnvelope(value.slice(PREFIX.length), privateKey, fp),
		getPublicKey: () => ({ publicKey, fingerprint: fp }),
	});
}

// Lightweight mock table: a Map of rows with the get/put/delete/search subset the ops use.
// `getDelay` widens the read→write window so interleaving tests can prove the per-name lock;
// `putCount` lets no-op tests assert nothing was written.
function installMockSecretTable({ getDelay = 0 } = {}) {
	const rows = new Map();
	const mock = {
		rows,
		putCount: 0,
		async get(id) {
			if (getDelay) await new Promise((resolve) => setTimeout(resolve, getDelay));
			return rows.get(id);
		},
		async put(row) {
			this.putCount++;
			rows.set(row.name, row);
		},
		async delete(id) {
			return rows.delete(id);
		},
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
			databases.system[SECRET_TABLE] = prior;
		},
	};
}

const su = (op) => ({ operation: op, hdb_user: { username: 'admin', role: { permission: { super_user: true } } } });
const nonSu = (op) => ({ operation: op, hdb_user: { username: 'joe', role: { permission: { super_user: false } } } });

describe('secretOperations', () => {
	let installed;
	beforeEach(() => {
		installed = installMockSecretTable();
	});
	afterEach(() => {
		installed.restore();
		clearSecretCustody();
	});

	describe('super_user enforcement (in-handler, allowlist-proof)', () => {
		const cases = [
			['setSecret', { name: 'A', value: 'x' }],
			['grantSecret', { name: 'A', component: 'c' }],
			['revokeSecret', { name: 'A', component: 'c' }],
			['listSecrets', {}],
			['deleteSecret', { name: 'A' }],
			['getSecretsPublicKey', {}],
		];
		for (const [fn, body] of cases) {
			it(`${fn} rejects a non-super_user caller with 403`, async () => {
				installCustody();
				await assert.rejects(
					async () => secretOps[fn]({ ...nonSu(fn), ...body }),
					(err) => err.statusCode === 403
				);
			});
		}
	});

	describe('set_secret with a plaintext value', () => {
		it('encrypts immediately, stores only ciphertext, and reports created', async () => {
			installCustody();
			const req = { ...su('set_secret'), name: 'API_KEY', value: 'hunter2', grants: ['my-app'] };
			const res = await secretOps.setSecret(req);
			assert.deepStrictEqual(res, { name: 'API_KEY', kid: fp, created: true });
			assert.equal(req.value, undefined, 'plaintext reference is dropped from the request');

			const row = installed.mock.rows.get('API_KEY');
			assert.ok(row.envelope.startsWith(PREFIX));
			assert.ok(!JSON.stringify(row).includes('hunter2'), 'plaintext never stored');
			assert.equal(decryptEnvelope(row.envelope.slice(PREFIX.length), privateKey, fp), 'hunter2');
			assert.deepStrictEqual(row.grants, ['my-app']);
			assert.equal(row.unverified, false);
			assert.equal(row.updated_by, 'admin');
		});

		it('updates an existing secret (created=false) and preserves grants/metadata when omitted', async () => {
			installCustody();
			await secretOps.setSecret({ ...su('set_secret'), name: 'A', value: 'v1', grants: ['app1'], metadata: { x: 1 } });
			const res = await secretOps.setSecret({ ...su('set_secret'), name: 'A', value: 'v2' });
			assert.equal(res.created, false);
			const row = installed.mock.rows.get('A');
			assert.deepStrictEqual(row.grants, ['app1']);
			assert.deepStrictEqual(row.metadata, { x: 1 });
			assert.equal(decryptEnvelope(row.envelope.slice(PREFIX.length), privateKey, fp), 'v2');
		});

		it('fails cleanly when no custody is registered', async () => {
			await assert.rejects(
				async () => secretOps.setSecret({ ...su('set_secret'), name: 'A', value: 'x' }),
				/secrets custody is not initialized/
			);
		});
	});

	describe('set_secret with a client-encrypted envelope', () => {
		it('accepts a verifiable envelope and derives kid from the sealed body', async () => {
			installCustody();
			const envelope = PREFIX + encryptEnvelope('s3cret', publicKey, fp);
			const res = await secretOps.setSecret({ ...su('set_secret'), name: 'B', envelope });
			assert.deepStrictEqual(res, { name: 'B', kid: fp, created: true });
			const row = installed.mock.rows.get('B');
			assert.equal(row.envelope, envelope);
			assert.equal(row.unverified, false);
		});

		it('rejects an envelope whose kid does not match custody (wrong key)', async () => {
			installCustody();
			const envelope = PREFIX + encryptEnvelope('s3cret', other.publicKey, otherFp);
			await assert.rejects(
				async () => secretOps.setSecret({ ...su('set_secret'), name: 'B', envelope }),
				/does not match this cluster's secrets key/
			);
			assert.equal(installed.mock.rows.size, 0);
		});

		it('accepts a kid-less envelope with custody registered, marked unverified', async () => {
			installCustody();
			const body = encryptEnvelope('s3cret', publicKey, fp);
			const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
			delete obj.kid;
			const envelope = PREFIX + Buffer.from(JSON.stringify(obj)).toString('base64url');
			const res = await secretOps.setSecret({ ...su('set_secret'), name: 'K', envelope });
			assert.deepStrictEqual(res, { name: 'K', kid: null, created: true });
			assert.equal(installed.mock.rows.get('K').unverified, true);
		});

		// Documented v1 trade: envelopes are never decrypted server-side (that would put the
		// plaintext in the main thread's heap), so a tampered-but-well-formed envelope with a
		// matching kid is accepted on ingest and only fails at consumption time.
		it('accepts a tampered-but-well-formed envelope (caught at consumption, not ingest)', async () => {
			installCustody();
			const body = encryptEnvelope('s3cret', publicKey, fp);
			const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
			const ct = Buffer.from(obj.ct, 'base64');
			ct[0] ^= 0xff;
			obj.ct = ct.toString('base64');
			const tampered = PREFIX + Buffer.from(JSON.stringify(obj)).toString('base64url');
			const res = await secretOps.setSecret({ ...su('set_secret'), name: 'T', envelope: tampered });
			assert.equal(res.kid, fp);
			// ...and the eventual consumer's decrypt does throw on it.
			assert.throws(() => decryptEnvelope(tampered.slice(PREFIX.length), privateKey, fp));
		});

		it('rejects a structurally malformed envelope body', async () => {
			installCustody();
			const envelope = PREFIX + Buffer.from(JSON.stringify({ k: 'only' })).toString('base64url');
			await assert.rejects(
				async () => secretOps.setSecret({ ...su('set_secret'), name: 'B', envelope }),
				/Invalid secret envelope/
			);
			// Non-base64 field content is also structural rejection.
			const badField =
				PREFIX + Buffer.from(JSON.stringify({ k: '!!', iv: 'aWl2', ct: '', tag: 'dGFn' })).toString('base64url');
			await assert.rejects(
				async () => secretOps.setSecret({ ...su('set_secret'), name: 'B', envelope: badField }),
				/Invalid secret envelope/
			);
		});

		it('accepts but marks unverified when no custody is registered', async () => {
			const envelope = PREFIX + encryptEnvelope('s3cret', other.publicKey, otherFp);
			const res = await secretOps.setSecret({ ...su('set_secret'), name: 'C', envelope });
			assert.deepStrictEqual(res, { name: 'C', kid: otherFp, created: true });
			assert.equal(installed.mock.rows.get('C').unverified, true);
		});
	});

	describe('grant_secret / revoke_secret', () => {
		it('adds and removes a component, idempotently', async () => {
			installCustody();
			await secretOps.setSecret({ ...su('set_secret'), name: 'G', value: 'x' });
			let res = await secretOps.grantSecret({ ...su('grant_secret'), name: 'G', component: 'app1' });
			assert.deepStrictEqual(res.grants, ['app1']);
			res = await secretOps.grantSecret({ ...su('grant_secret'), name: 'G', component: 'app1' });
			assert.deepStrictEqual(res.grants, ['app1'], 'granting twice is a no-op');
			res = await secretOps.revokeSecret({ ...su('revoke_secret'), name: 'G', component: 'app1' });
			assert.deepStrictEqual(res.grants, []);
			res = await secretOps.revokeSecret({ ...su('revoke_secret'), name: 'G', component: 'app1' });
			assert.deepStrictEqual(res.grants, [], 'revoking twice is a no-op');
			// The envelope survives grant churn untouched.
			const row = installed.mock.rows.get('G');
			assert.equal(decryptEnvelope(row.envelope.slice(PREFIX.length), privateKey, fp), 'x');
		});

		it('404s on a missing secret', async () => {
			await assert.rejects(
				async () => secretOps.grantSecret({ ...su('grant_secret'), name: 'NOPE', component: 'app1' }),
				(err) => err.statusCode === 404
			);
		});

		it('no-op grant/revoke returns changed:false without writing or bumping updated_by', async () => {
			installCustody();
			await secretOps.setSecret({ ...su('set_secret'), name: 'N', value: 'x', grants: ['app1'] });
			const putsAfterSet = installed.mock.putCount;
			const rowBefore = installed.mock.rows.get('N');

			const grantRes = await secretOps.grantSecret({
				operation: 'grant_secret',
				hdb_user: { username: 'other-admin', role: { permission: { super_user: true } } },
				name: 'N',
				component: 'app1',
			});
			assert.deepStrictEqual(grantRes, { name: 'N', grants: ['app1'], changed: false });

			const revokeRes = await secretOps.revokeSecret({ ...su('revoke_secret'), name: 'N', component: 'ghost' });
			assert.deepStrictEqual(revokeRes, { name: 'N', grants: ['app1'], changed: false });

			assert.equal(installed.mock.putCount, putsAfterSet, 'no table.put on a no-op');
			assert.strictEqual(installed.mock.rows.get('N'), rowBefore, 'row object untouched');
			assert.equal(rowBefore.updated_by, 'admin', 'updated_by not bumped by the no-op');
		});

		it('rejects explicit duplicate grants in set_secret input (Joi .unique())', async () => {
			installCustody();
			await assert.rejects(
				async () => secretOps.setSecret({ ...su('set_secret'), name: 'DUP', value: 'x', grants: ['web', 'web'] }),
				(err) => err.statusCode === 400
			);
		});

		it('revoke removes ALL occurrences from a dirty duplicated row', async () => {
			// Force dirty state directly (e.g. a row replicated from a node predating the dedupe).
			installed.mock.rows.set('DIRTY', {
				name: 'DIRTY',
				envelope: PREFIX + 'xxxx',
				kid: fp,
				grants: ['web', 'web', 'other'],
			});
			const res = await secretOps.revokeSecret({ ...su('revoke_secret'), name: 'DIRTY', component: 'web' });
			assert.deepStrictEqual(res, { name: 'DIRTY', grants: ['other'], changed: true });
			assert.deepStrictEqual(installed.mock.rows.get('DIRTY').grants, ['other'], 'no residual duplicate grant');
		});

		it('grant on a dirty duplicated row persists the normalized (deduped) set', async () => {
			installed.mock.rows.set('DIRTY2', {
				name: 'DIRTY2',
				envelope: PREFIX + 'xxxx',
				kid: fp,
				grants: ['web', 'web'],
			});
			// Component already present, but the stored row is dirty — not a no-op: it normalizes.
			const res = await secretOps.grantSecret({ ...su('grant_secret'), name: 'DIRTY2', component: 'web' });
			assert.deepStrictEqual(res, { name: 'DIRTY2', grants: ['web'], changed: true });
			assert.deepStrictEqual(installed.mock.rows.get('DIRTY2').grants, ['web']);
		});

		it('reports changed:true when a mutation actually happens', async () => {
			installCustody();
			await secretOps.setSecret({ ...su('set_secret'), name: 'N2', value: 'x' });
			const res = await secretOps.grantSecret({ ...su('grant_secret'), name: 'N2', component: 'app1' });
			assert.deepStrictEqual(res, { name: 'N2', grants: ['app1'], changed: true });
		});

		it('interleaved grant+revoke both land (per-name lock serializes read-modify-write)', async () => {
			// Reinstall with a slow get: without the lock, both mutations read the same snapshot
			// and the second put would silently erase the first mutation.
			installed.restore();
			installed = installMockSecretTable({ getDelay: 10 });
			installCustody();
			await secretOps.setSecret({ ...su('set_secret'), name: 'R', value: 'x', grants: ['a'] });

			await Promise.all([
				secretOps.grantSecret({ ...su('grant_secret'), name: 'R', component: 'b' }),
				secretOps.revokeSecret({ ...su('revoke_secret'), name: 'R', component: 'a' }),
			]);
			assert.deepStrictEqual(installed.mock.rows.get('R').grants, ['b']);
		});

		it('concurrent grants of different components both land', async () => {
			installed.restore();
			installed = installMockSecretTable({ getDelay: 10 });
			installCustody();
			await secretOps.setSecret({ ...su('set_secret'), name: 'C2', value: 'x' });

			await Promise.all([
				secretOps.grantSecret({ ...su('grant_secret'), name: 'C2', component: 'x1' }),
				secretOps.grantSecret({ ...su('grant_secret'), name: 'C2', component: 'x2' }),
			]);
			assert.deepStrictEqual([...installed.mock.rows.get('C2').grants].sort(), ['x1', 'x2']);
		});

		it('concurrent set_secret and grant_secret preserve both the new envelope and the grant', async () => {
			installed.restore();
			installed = installMockSecretTable({ getDelay: 10 });
			installCustody();
			await secretOps.setSecret({ ...su('set_secret'), name: 'M', value: 'v1' });

			await Promise.all([
				secretOps.setSecret({ ...su('set_secret'), name: 'M', value: 'v2' }),
				secretOps.grantSecret({ ...su('grant_secret'), name: 'M', component: 'app1' }),
			]);
			const row = installed.mock.rows.get('M');
			assert.deepStrictEqual(row.grants, ['app1'], 'grant survives the concurrent re-set');
			assert.equal(decryptEnvelope(row.envelope.slice(PREFIX.length), privateKey, fp), 'v2', 'new value survives');
		});
	});

	describe('list_secrets', () => {
		it('returns metadata only — never envelopes or values — with custody match flags', async () => {
			installCustody();
			await secretOps.setSecret({ ...su('set_secret'), name: 'S1', value: 'v1', metadata: { note: 'db' } });
			// A stale row from a previous key (e.g. a cloned node).
			installed.mock.rows.set('S2', { name: 'S2', envelope: PREFIX + 'xxxx', kid: otherFp, grants: [] });

			const res = await secretOps.listSecrets(su('list_secrets'));
			assert.equal(res.custody_fingerprint, fp);
			assert.equal(res.secrets.length, 2);
			const [s1, s2] = res.secrets; // sorted by name
			assert.equal(s1.name, 'S1');
			assert.equal(s1.kid_matches_custody, true);
			assert.deepStrictEqual(s1.metadata, { note: 'db' });
			assert.equal(s2.name, 'S2');
			assert.equal(s2.kid_matches_custody, false);
			assert.ok(!JSON.stringify(res).includes('envelope'), 'envelopes never leave through list_secrets');
			assert.ok(!JSON.stringify(res).includes('v1"'), 'values never leave through list_secrets');
		});

		it('reports a null custody fingerprint when no custody is registered', async () => {
			const res = await secretOps.listSecrets(su('list_secrets'));
			assert.equal(res.custody_fingerprint, null);
			assert.deepStrictEqual(res.secrets, []);
		});
	});

	describe('delete_secret', () => {
		it('deletes an existing secret and 404s on a missing one', async () => {
			installCustody();
			await secretOps.setSecret({ ...su('set_secret'), name: 'D', value: 'x' });
			const res = await secretOps.deleteSecret({ ...su('delete_secret'), name: 'D' });
			assert.match(res.message, /Successfully deleted/);
			assert.equal(installed.mock.rows.size, 0);
			await assert.rejects(
				async () => secretOps.deleteSecret({ ...su('delete_secret'), name: 'D' }),
				(err) => err.statusCode === 404
			);
		});
	});

	describe('read_audit_log on system.hdb_secret', () => {
		it('is blocked (audit rows would expose envelopes; table audit itself must stay on)', async () => {
			const readAuditLog = require('#src/dataLayer/readAuditLog').default;
			await assert.rejects(
				async () => readAuditLog({ database: 'system', table: SECRET_TABLE }),
				(err) => err.statusCode === 403
			);
		});
	});

	describe('get_secrets_public_key', () => {
		it('returns the public key and fingerprint from custody', () => {
			installCustody();
			const res = secretOps.getSecretsPublicKey(su('get_secrets_public_key'));
			assert.equal(res.public_key, publicKey);
			assert.equal(res.fingerprint, fp);
		});

		it('fails cleanly when custody is absent', () => {
			assert.throws(
				() => secretOps.getSecretsPublicKey(su('get_secrets_public_key')),
				/secrets custody is not initialized/
			);
		});
	});
});
