'use strict';

// Login tokens (create_authentication_tokens with purpose: 'login'), which the `login` operation trades for a session
// cookie: bound to the stored user record they were minted from, and capped in lifetime (harper#4618).

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createPrivateKey } = require('node:crypto');
const jwt = require('jsonwebtoken');
const testUtils = require('../testUtils.js');
const user = require('#src/security/user');
const tokenAuthentication = require('#src/security/tokenAuthentication');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const { CONFIG_PARAMS } = terms;
const { databases } = require('#src/resources/databases');

const PASSWORD = 'login-token-password';
const USERNAMES = ['login_unit_a', 'login_unit_b', 'login_unit_c'];

const claimsOf = (token) => jwt.decode(token, { json: true });
const lifetimeOf = (token) => {
	const { exp, iat } = claimsOf(token);
	return exp - iat;
};
const isInvalidToken = (error) => error.statusCode === 401 && error.message === 'invalid token';
const isInvalidCredentials = (error) => error.statusCode === 401 && error.message === 'invalid credentials';

async function addUser(username, password = PASSWORD) {
	await user.addUser({ username, password, role: 'super_user', active: true });
}

async function mint(username, fields = {}) {
	const { operation_token, refresh_token } = await tokenAuthentication.createTokens({
		username,
		password: PASSWORD,
		purpose: 'login',
		...fields,
	});
	assert.strictEqual(refresh_token, undefined);
	return operation_token;
}

// as the operations API hands createTokens a caller that sent no username or password
async function mintFor(principal, fields = {}) {
	return (await tokenAuthentication.createTokens({ hdb_user: principal, purpose: 'login', ...fields })).operation_token;
}

function setMaxLoginTokenTimeout(value) {
	const original = env.get(CONFIG_PARAMS.AUTHENTICATION_MAXLOGINTOKENTIMEOUT);
	env.setProperty(CONFIG_PARAMS.AUTHENTICATION_MAXLOGINTOKENTIMEOUT, value);
	return () => env.setProperty(CONFIG_PARAMS.AUTHENTICATION_MAXLOGINTOKENTIMEOUT, original);
}

describe('login tokens', function () {
	let removeJwtKeys;

	before(async () => {
		testUtils.preTestPrep();
		testUtils.setupTestDBPath();
		await testUtils.ensureSystemTables();
		removeJwtKeys = testUtils.installTestJwtKeys();
		tokenAuthentication.clearJWTRSAKeysCache();
	});

	beforeEach(async () => {
		for (const username of USERNAMES) await addUser(username);
	});

	afterEach(async () => {
		for (const username of USERNAMES) await user.dropUser({ username }).catch(() => {});
	});

	after(() => {
		removeJwtKeys?.();
		tokenAuthentication.clearJWTRSAKeysCache();
	});

	describe('lifetime', () => {
		it('lasts one minute by default and redeems for the stored user', async () => {
			const token = await mint('login_unit_a');
			assert.strictEqual(lifetimeOf(token), 60);
			assert.strictEqual(claimsOf(token).sub, 'login');
			const redeemed = await tokenAuthentication.validateLoginToken(token);
			assert.strictEqual(redeemed.username, 'login_unit_a');
			assert.strictEqual(redeemed.active, true);
			assert.strictEqual(redeemed.role.permission.super_user, true);
		});

		it('writes nothing to the user record', async () => {
			const before = databases.system.hdb_user.primaryStore.getEntry('login_unit_a');
			await mint('login_unit_a');
			const after = databases.system.hdb_user.primaryStore.getEntry('login_unit_a');
			assert.strictEqual(after.version, before.version);
			assert.strictEqual(after.value.refresh_token, before.value.refresh_token);
		});

		it('caps a longer expires_in at five minutes by default', async () => {
			assert.strictEqual(lifetimeOf(await mint('login_unit_a', { expires_in: '3650d' })), 300);
			assert.strictEqual(lifetimeOf(await mint('login_unit_a', { expires_in: 10 ** 9 })), 300);
			const capped = await mint('login_unit_a', { expires_in: '1d' });
			assert.strictEqual(lifetimeOf(capped), 300);
			assert.strictEqual((await tokenAuthentication.validateLoginToken(capped)).username, 'login_unit_a');
		});

		it('caps a credential-free mint the same way', async () => {
			const principal = await user.findAndValidateUser('login_unit_a', PASSWORD);
			assert.strictEqual(lifetimeOf(await mintFor(principal, { expires_in: '3650d' })), 300);
		});

		it('keeps a shorter expires_in as jsonwebtoken reads it', async () => {
			assert.strictEqual(lifetimeOf(await mint('login_unit_a', { expires_in: '30s' })), 30);
			assert.strictEqual(lifetimeOf(await mint('login_unit_a', { expires_in: 45 })), 45);
			// jsonwebtoken reads a unitless string as milliseconds
			assert.strictEqual(lifetimeOf(await mint('login_unit_a', { expires_in: '120000' })), 120);
		});

		it('reads authentication.maxLoginTokenTimeout at each mint', async () => {
			for (const [configured, expected] of [
				['2m', 120],
				['90', 90],
				[45, 45],
				['1d', 86400],
			]) {
				const restore = setMaxLoginTokenTimeout(configured);
				try {
					assert.strictEqual(lifetimeOf(await mint('login_unit_a', { expires_in: '3650d' })), expected, configured);
				} finally {
					restore();
				}
			}
			const restore = setMaxLoginTokenTimeout('30s');
			try {
				assert.strictEqual(lifetimeOf(await mint('login_unit_a')), 30, 'the one-minute default is capped too');
			} finally {
				restore();
			}
		});

		it('keeps the five-minute cap when the configured maximum is one the config validator refuses', async () => {
			// what the config validator refuses, including units convertToMS reads but the validator does not (5M is five months)
			for (const configured of ['soon', '0', -5, '0.5s', '5M', '1y', Infinity]) {
				const restore = setMaxLoginTokenTimeout(configured);
				try {
					assert.strictEqual(lifetimeOf(await mint('login_unit_a', { expires_in: '3650d' })), 300, String(configured));
				} finally {
					restore();
				}
			}
		});
	});

	describe('binding to the stored user record', () => {
		it('a password change ends a token minted before it', async () => {
			const token = await mint('login_unit_a');
			await user.alterUser({ username: 'login_unit_a', password: 'a-new-password' });
			await assert.rejects(tokenAuthentication.validateLoginToken(token), isInvalidToken);
			const fresh = await mint('login_unit_a', { password: 'a-new-password' });
			assert.strictEqual((await tokenAuthentication.validateLoginToken(fresh)).username, 'login_unit_a');
		});

		it('setting the same password again ends it too, since every password write re-salts the hash', async () => {
			const token = await mint('login_unit_a');
			await user.alterUser({ username: 'login_unit_a', password: PASSWORD });
			await assert.rejects(tokenAuthentication.validateLoginToken(token), isInvalidToken);
		});

		it('drop_user ends it, and a still-valid credential of the dropped user mints no new one', async () => {
			const principal = await user.findAndValidateUser('login_unit_a', PASSWORD);
			const token = await mintFor(principal);
			assert.strictEqual((await tokenAuthentication.validateLoginToken(token)).username, 'login_unit_a');
			await user.dropUser({ username: 'login_unit_a' });
			await assert.rejects(tokenAuthentication.validateLoginToken(token), isInvalidToken);
			await assert.rejects(mintFor(principal), isInvalidCredentials);
		});

		it('a username dropped and recreated with the same password does not inherit it', async () => {
			const token = await mint('login_unit_a');
			await user.dropUser({ username: 'login_unit_a' });
			await addUser('login_unit_a');
			await assert.rejects(tokenAuthentication.validateLoginToken(token), isInvalidToken);
			assert.strictEqual(
				(await tokenAuthentication.validateLoginToken(await mint('login_unit_a'))).username,
				'login_unit_a'
			);
		});

		it('a record put back under the name with the same password hash does not inherit it', async () => {
			const token = await mint('login_unit_a');
			const stored = { ...(await databases.system.hdb_user.get('login_unit_a')) };
			await user.dropUser({ username: 'login_unit_a' });
			await databases.system.hdb_user.put(stored);
			assert.strictEqual((await databases.system.hdb_user.get('login_unit_a')).password, stored.password);
			await assert.rejects(tokenAuthentication.validateLoginToken(token), isInvalidToken);
		});

		it('deactivating the user ends it and stops new mints', async () => {
			const token = await mint('login_unit_a');
			await user.alterUser({ username: 'login_unit_a', active: false });
			await assert.rejects(tokenAuthentication.validateLoginToken(token), isInvalidToken);
			await assert.rejects(mint('login_unit_a'), isInvalidCredentials);
		});

		it('an ordinary token mint for the same user, which rewrites its refresh token, leaves it usable', async () => {
			const token = await mint('login_unit_a');
			const ordinary = await tokenAuthentication.createTokens({ username: 'login_unit_a', password: PASSWORD });
			assert.ok(ordinary.refresh_token);
			assert.strictEqual((await tokenAuthentication.validateLoginToken(token)).username, 'login_unit_a');
		});

		it("another user's change leaves it usable", async () => {
			const token = await mint('login_unit_a');
			await user.alterUser({ username: 'login_unit_b', password: 'b-new-password' });
			await user.dropUser({ username: 'login_unit_c' });
			assert.strictEqual((await tokenAuthentication.validateLoginToken(token)).username, 'login_unit_a');
		});

		it('refuses a login token minted with no binding, as before this check', async () => {
			const keys = await tokenAuthentication.getJWTRSAKeys();
			const unbound = jwt.sign(
				{ username: 'login_unit_a' },
				{ key: keys.privateKey, passphrase: keys.passphrase },
				{ expiresIn: '1m', algorithm: 'RS256', subject: 'login' }
			);
			await assert.rejects(tokenAuthentication.validateLoginToken(unbound), isInvalidToken);
		});

		it('refuses a credential-free mint for a principal no stored record has', async () => {
			await assert.rejects(mintFor({ username: 'never_stored_login_user', active: true }), isInvalidCredentials);
		});

		it('keeps its binding when the signing key is stored in another PEM encoding', async () => {
			const token = await mint('login_unit_a');
			const keys = await tokenAuthentication.getJWTRSAKeys();
			const keysDir = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME);
			const reencoded = createPrivateKey({ key: keys.privateKey, passphrase: keys.passphrase }).export({
				type: 'pkcs8',
				format: 'pem',
				cipher: 'aes-256-cbc',
				passphrase: 'another-passphrase',
			});
			assert.notStrictEqual(reencoded, keys.privateKey);
			fs.writeFileSync(path.join(keysDir, terms.JWT_ENUM.JWT_PRIVATE_KEY_NAME), reencoded);
			fs.writeFileSync(path.join(keysDir, terms.JWT_ENUM.JWT_PASSPHRASE_NAME), 'another-passphrase');
			tokenAuthentication.clearJWTRSAKeysCache();
			assert.strictEqual((await tokenAuthentication.validateLoginToken(token)).username, 'login_unit_a');
		});
	});

	describe('findAndBindUser and findLoginTokenUser', () => {
		const keyA = Buffer.from('a binding key');
		const keyB = Buffer.from('another binding key');

		it('findAndBindUser validates as findAndValidateUser does, and binds only an active record', async () => {
			const { user: found, bind } = await user.findAndBindUser('login_unit_a', PASSWORD, true);
			assert.strictEqual(found.username, 'login_unit_a');
			assert.strictEqual(typeof bind(keyA), 'string');
			assert.notStrictEqual(bind(keyA), bind(keyB));
			assert.strictEqual(bind(Buffer.alloc(0)), undefined);
			await assert.rejects(user.findAndBindUser('login_unit_a', 'wrong password', true));
			const recordless = await user.findAndBindUser('never_stored_login_user', undefined, false);
			assert.strictEqual(recordless.user.username, 'never_stored_login_user');
			assert.strictEqual(recordless.bind(keyA), undefined);
		});

		it('findLoginTokenUser returns the user and its role from the record matching the binding, and nothing otherwise', async () => {
			const binding = (await user.findAndBindUser('login_unit_a', PASSWORD, true)).bind(keyA);
			const found = user.findLoginTokenUser('login_unit_a', binding, keyA);
			assert.strictEqual(found.username, 'login_unit_a');
			assert.strictEqual(found.role.permission.super_user, true);
			assert.strictEqual(user.findLoginTokenUser('login_unit_b', binding, keyA), undefined);
			assert.strictEqual(user.findLoginTokenUser('login_unit_a', undefined, keyA), undefined);
			assert.strictEqual(user.findLoginTokenUser('login_unit_a', binding, keyB), undefined);
		});
	});

	describe('where a login token is accepted', () => {
		it('only the login exchange accepts it, and the login exchange accepts nothing else', async () => {
			const token = await mint('login_unit_a');
			await assert.rejects(tokenAuthentication.validateOperationToken(token), isInvalidToken);
			await assert.rejects(tokenAuthentication.validateRefreshToken(token), isInvalidToken);
			const ordinary = await tokenAuthentication.createTokens({ username: 'login_unit_a', password: PASSWORD });
			await assert.rejects(tokenAuthentication.validateLoginToken(ordinary.operation_token), isInvalidToken);
			await assert.rejects(tokenAuthentication.validateLoginToken(ordinary.refresh_token), isInvalidToken);
			await assert.rejects(tokenAuthentication.validateLoginToken('not-a-token'), isInvalidToken);
		});

		it('an expired one is refused as expired', async () => {
			const expired = await mint('login_unit_a', { expires_in: -1 });
			await assert.rejects(
				tokenAuthentication.validateLoginToken(expired),
				(error) => error.statusCode === 403 && error.message === 'token expired'
			);
		});
	});
});
