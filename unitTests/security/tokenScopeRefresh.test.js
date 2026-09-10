'use strict';

// A scoped credential must only ever produce an equally-scoped one (#2174). refresh_operation_token
// mints a fresh operation token from a refresh token; if it dropped the `operations` claim, a scoped
// refresh credential would refresh back to the full role. This drives the real validate→decode→sign
// path with the test signing keys rather than asserting the payload in isolation.

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { refreshOperationToken, clearJWTRSAKeysCache } = require('#src/security/tokenAuthentication');
const password = require('#src/utility/password');
const { setUsersWithRolesCache } = require('#src/security/user');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');

const USERNAME = 'ci-deploy';

function payloadOf(token) {
	return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

describe('refresh_operation_token operation scope', () => {
	let removeJwtKeys;
	let privateKey;
	let passphrase;

	before(async () => {
		removeJwtKeys = testUtils.installTestJwtKeys();
		clearJWTRSAKeysCache();
		// Sign the refresh token with the exact keys refreshOperationToken will verify against.
		const keysDir = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME);
		privateKey = fs.readFileSync(path.join(keysDir, terms.JWT_ENUM.JWT_PRIVATE_KEY_NAME));
		passphrase = fs.readFileSync(path.join(keysDir, terms.JWT_ENUM.JWT_PASSPHRASE_NAME), 'utf8');
	});

	after(() => {
		removeJwtKeys();
		clearJWTRSAKeysCache();
	});

	// Mints a `refresh`-subject token and seeds the users cache so validateRefreshToken accepts it
	// (it matches the token against the SHA-256 hash stored on the user).
	async function seedRefreshToken(claims) {
		const refreshToken = jwt.sign(
			claims,
			{ key: privateKey, passphrase },
			{
				algorithm: 'RS256',
				subject: 'refresh',
				expiresIn: '30d',
			}
		);
		const users = new Map([
			[
				USERNAME,
				{
					username: USERNAME,
					active: true,
					refresh_token: password.hash(refreshToken, password.HASH_FUNCTION.SHA256),
					role: { role: 'deployer', permission: { super_user: false } },
				},
			],
		]);
		await setUsersWithRolesCache(users);
		return refreshToken;
	}

	it('carries the scope from the refresh token into the minted operation token', async () => {
		const refreshToken = await seedRefreshToken({
			username: USERNAME,
			super_user: false,
			operations: ['deploy_component'],
		});
		const { operation_token } = await refreshOperationToken({ refresh_token: refreshToken });
		assert.deepStrictEqual(payloadOf(operation_token).operations, ['deploy_component']);
	});

	it('mints an unscoped operation token from an unscoped refresh token', async () => {
		const refreshToken = await seedRefreshToken({ username: USERNAME, super_user: false });
		const { operation_token } = await refreshOperationToken({ refresh_token: refreshToken });
		assert.strictEqual(payloadOf(operation_token).operations, undefined);
	});
});
