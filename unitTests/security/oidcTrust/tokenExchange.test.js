'use strict';

// End-to-end tests for exchange_oidc_token: a real signed identity token, served through a real
// JWKS fetch, verified and matched against real trust policies, exchanged for a real operation
// token. Only two things are displaced — the network (a fetch responder) and the two system tables
// (Map-backed mocks on databases.system).

const assert = require('node:assert');
const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { generateKeyPairSync, createPublicKey } = require('node:crypto');
const { exchangeOidcToken } = require('#src/security/oidcTrust/tokenExchange');
const { addOidcTrust } = require('#src/security/oidcTrust/trustPolicyOperations');
const { clearJwksCache } = require('#src/security/oidcTrust/jwks');
const { validateOperationToken, clearJWTRSAKeysCache, decodeJWT } = require('#src/security/tokenAuthentication');
const { databases } = require('#src/resources/databases');
const { setUsersWithRolesCache } = require('#src/security/user');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');

const TRUST_TABLE = terms.SYSTEM_TABLE_NAMES.OIDC_TRUST_TABLE_NAME;
const TOKEN_USE_TABLE = 'hdb_oidc_token_use';
const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URI = ISSUER + '/.well-known/jwks';
const DISCOVERY_URI = ISSUER + '/.well-known/openid-configuration';
const AUDIENCE = 'https://my-instance.harperdb.io:9925/';
const WORKFLOW_REF = 'HarperFast/my-app/.github/workflows/deploy.yml@refs/heads/main';
const OIDC_KID = 'gh-signing-key';

let issuerPrivateKey;
let signingJwk;

/** Writes the RSA keys createOperationToken signs with into the isolated test base path. */
function installJwtSigningKeys() {
	const passphrase = 'test-passphrase';
	const { privateKey, publicKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
	});
	const keysDir = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME);
	fs.mkdirSync(keysDir, { recursive: true });
	fs.writeFileSync(path.join(keysDir, terms.JWT_ENUM.JWT_PRIVATE_KEY_NAME), privateKey);
	fs.writeFileSync(path.join(keysDir, terms.JWT_ENUM.JWT_PUBLIC_KEY_NAME), publicKey);
	fs.writeFileSync(path.join(keysDir, terms.JWT_ENUM.JWT_PASSPHRASE_NAME), passphrase);
	clearJWTRSAKeysCache();
}

function installMockTable(name, primaryKey) {
	const rows = new Map();
	const mock = {
		rows,
		async get(id) {
			return rows.get(id);
		},
		async put(row) {
			rows.set(row[primaryKey], row);
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
	const prior = databases.system[name];
	databases.system[name] = mock;
	return { mock, restore: () => (databases.system[name] = prior) };
}

function seedUsers() {
	const users = new Map();
	users.set('ci-deploy', {
		username: 'ci-deploy',
		active: true,
		role: { role: 'deployer', permission: { super_user: false } },
	});
	users.set('admin', { username: 'admin', active: true, role: { role: 'su', permission: { super_user: true } } });
	users.set('retired', { username: 'retired', active: false, role: { role: 'deployer', permission: {} } });
	return setUsersWithRolesCache(users);
}

const asAdmin = (body) => ({
	operation: 'add_oidc_trust',
	hdb_user: { username: 'admin', role: { permission: { super_user: true } } },
	...body,
});

describe('exchangeOidcToken', () => {
	let trustTable;
	let useTable;
	let realFetch;
	let tokenCounter = 0;

	before(() => {
		installJwtSigningKeys();
		const pair = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		});
		issuerPrivateKey = pair.privateKey;
		signingJwk = {
			...createPublicKey(pair.publicKey).export({ format: 'jwk' }),
			kid: OIDC_KID,
			use: 'sig',
			alg: 'RS256',
		};
	});

	beforeEach(async () => {
		clearJwksCache();
		trustTable = installMockTable(TRUST_TABLE, 'id');
		useTable = installMockTable(TOKEN_USE_TABLE, 'id');
		await seedUsers();
		realFetch = globalThis.fetch;
		globalThis.fetch = async (url) =>
			new Response(
				JSON.stringify(String(url) === DISCOVERY_URI ? { issuer: ISSUER, jwks_uri: JWKS_URI } : { keys: [signingJwk] }),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		trustTable.restore();
		useTable.restore();
	});

	function identityToken(overrides = {}) {
		const now = Math.floor(Date.now() / 1000);
		return jwt.sign(
			{
				iss: ISSUER,
				aud: AUDIENCE,
				sub: 'repo:HarperFast/my-app:environment:production',
				jti: `token-${++tokenCounter}`,
				iat: now,
				exp: now + 300,
				repository: 'HarperFast/my-app',
				repository_id: '67890',
				repository_owner_id: '12345',
				workflow_ref: WORKFLOW_REF,
				environment: 'production',
				ref: 'refs/heads/main',
				event_name: 'push',
				runner_environment: 'github-hosted',
				run_id: '99',
				actor: 'octocat',
				...overrides,
			},
			issuerPrivateKey,
			{ algorithm: 'RS256', header: { alg: 'RS256', kid: OIDC_KID } }
		);
	}

	function addPolicy(overrides = {}) {
		return addOidcTrust(
			asAdmin({
				id: 'my-app-prod',
				issuer: ISSUER,
				audience: AUDIENCE,
				claims: { repository_id: '67890', workflow_ref: WORKFLOW_REF },
				user: 'ci-deploy',
				...overrides,
			})
		);
	}

	async function assertRejected(promise) {
		await assert.rejects(promise, (error) => {
			assert.strictEqual(error.statusCode, 401);
			// One message for every failure: a caller told which check failed can enumerate a policy.
			assert.strictEqual(error.message, 'Identity token was rejected');
			return true;
		});
	}

	it('exchanges a matching token for a usable operation token', async () => {
		await addPolicy();
		const result = await exchangeOidcToken({ operation: 'exchange_oidc_token', token: identityToken() });

		assert.strictEqual(result.username, 'ci-deploy');
		assert.strictEqual(result.policy, 'my-app-prod');
		assert.strictEqual(result.expires_in, 3600);

		const user = await validateOperationToken(result.operation_token);
		assert.strictEqual(user.username, 'ci-deploy');
	});

	// The whole point of trusted publishing: CI ends up holding nothing durable, and the user's
	// existing refresh credential is not rotated out from under whoever holds it (#2018).
	it('mints no refresh token', async () => {
		await addPolicy();
		const result = await exchangeOidcToken({ operation: 'exchange_oidc_token', token: identityToken() });
		assert.strictEqual(result.refresh_token, undefined);
		assert.ok(decodeJWT(result.operation_token).exp, 'expected a bounded lifetime');
	});

	it('refuses to spend the same token twice', async () => {
		await addPolicy();
		const token = identityToken();
		await exchangeOidcToken({ operation: 'exchange_oidc_token', token });
		await assertRejected(exchangeOidcToken({ operation: 'exchange_oidc_token', token }));
	});

	it('records the spent token against the policy, expiring with the token', async () => {
		await addPolicy();
		const token = identityToken();
		await exchangeOidcToken({ operation: 'exchange_oidc_token', token });

		const [record] = [...useTable.mock.rows.values()];
		assert.strictEqual(record.policy_id, 'my-app-prod');
		const tokenExpiryMs = decodeJWT(token).exp * 1000;
		assert.ok(record.expiresAt > tokenExpiryMs, 'record must outlive the token it guards');
	});

	it('rejects a token minted for a different audience', async () => {
		await addPolicy();
		await assertRejected(
			exchangeOidcToken({
				operation: 'exchange_oidc_token',
				token: identityToken({ aud: 'https://github.com/HarperFast' }),
			})
		);
	});

	it('rejects a run from a branch the policy does not name', async () => {
		await addPolicy();
		await assertRejected(
			exchangeOidcToken({
				operation: 'exchange_oidc_token',
				token: identityToken({
					workflow_ref: 'HarperFast/my-app/.github/workflows/deploy.yml@refs/heads/attacker',
					ref: 'refs/heads/attacker',
				}),
			})
		);
	});

	it('rejects a run from a different repository', async () => {
		await addPolicy();
		await assertRejected(
			exchangeOidcToken({
				operation: 'exchange_oidc_token',
				token: identityToken({ repository_id: '11111', repository: 'attacker/evil' }),
			})
		);
	});

	it('rejects when no policy exists for the issuer', async () => {
		await assertRejected(exchangeOidcToken({ operation: 'exchange_oidc_token', token: identityToken() }));
	});

	it('ignores a disabled policy', async () => {
		await addPolicy({ enabled: false });
		await assertRejected(exchangeOidcToken({ operation: 'exchange_oidc_token', token: identityToken() }));
	});

	it('selects the first matching policy by id when several match', async () => {
		await addPolicy({ id: 'zulu', user: 'admin' });
		await addPolicy({ id: 'alpha', user: 'ci-deploy' });
		const result = await exchangeOidcToken({ operation: 'exchange_oidc_token', token: identityToken() });
		assert.strictEqual(result.policy, 'alpha');
		assert.strictEqual(result.username, 'ci-deploy');
	});

	it('rejects a policy naming a user that no longer exists, without spending the token', async () => {
		await addPolicy();
		await setUsersWithRolesCache(new Map());
		const token = identityToken();
		await assertRejected(exchangeOidcToken({ operation: 'exchange_oidc_token', token }));
		assert.strictEqual(useTable.mock.rows.size, 0, 'a token the runner cannot re-mint must not be burned');
	});

	// add_oidc_trust refuses an inactive user outright, so the case that reaches here is a user
	// deactivated after the policy was written — deactivating a user must stop its workflows.
	it('rejects a policy whose user has since been deactivated', async () => {
		await addPolicy();
		const users = new Map();
		users.set('ci-deploy', { username: 'ci-deploy', active: false, role: { role: 'deployer', permission: {} } });
		await setUsersWithRolesCache(users);

		const token = identityToken();
		await assertRejected(exchangeOidcToken({ operation: 'exchange_oidc_token', token }));
		assert.strictEqual(useTable.mock.rows.size, 0, 'a token the runner cannot re-mint must not be burned');
	});

	it('rejects an expired token', async () => {
		await addPolicy();
		const past = Math.floor(Date.now() / 1000) - 7200;
		await assertRejected(
			exchangeOidcToken({ operation: 'exchange_oidc_token', token: identityToken({ iat: past, exp: past + 300 }) })
		);
	});

	it('rejects a token signed by a key the issuer does not publish', async () => {
		await addPolicy();
		const { privateKey } = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		});
		const forged = jwt.sign(
			{ iss: ISSUER, aud: AUDIENCE, jti: 'forged', exp: Math.floor(Date.now() / 1000) + 300 },
			privateKey,
			{
				algorithm: 'RS256',
				header: { alg: 'RS256', kid: OIDC_KID },
			}
		);
		await assertRejected(exchangeOidcToken({ operation: 'exchange_oidc_token', token: forged }));
	});

	it('rejects malformed input', async () => {
		await addPolicy();
		for (const token of ['not-a-jwt', 'a.b.c']) {
			await assertRejected(exchangeOidcToken({ operation: 'exchange_oidc_token', token }));
		}
		for (const token of ['', undefined, 42, { nested: true }]) {
			await assert.rejects(() => exchangeOidcToken({ operation: 'exchange_oidc_token', token }));
		}
	});
});
