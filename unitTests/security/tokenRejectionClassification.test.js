'use strict';

/**
 * `validateToken()` decides whether a Bearer failure is "this token is not acceptable" or "Harper
 * could not evaluate it". Only the first may be deferred past route matching, so this suite
 * drives the real `validateOperationToken`/`validateRefreshToken` against real RSA key material and
 * asserts the classification the authentication middleware then acts on.
 */
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const jwt = require('jsonwebtoken');

const { JWT_ENUM, LICENSE_KEY_DIR_NAME } = require('#src/utility/hdbTerms');
const env = require('#src/utility/environment/environmentManager');
const { isCredentialRejection } = require('#src/security/deferredAuthentication');
const {
	clearJWTRSAKeysCache,
	validateOperationToken,
	validateRefreshToken,
} = require('#src/security/tokenAuthentication');
const { setUsersWithRolesCache } = require('#src/security/user');

const KNOWN_USER = new Map([['known_user', { username: 'known_user', active: true, role: { permission: {} } }]]);

/** Captures the error `fn()` raises, so a resolving call fails loudly instead of silently passing. */
async function raisedBy(fn) {
	try {
		await fn();
	} catch (error) {
		return error;
	}
	assert.fail('expected the call to raise');
}

describe('token rejection versus internal authentication fault', () => {
	let removeJwtKeys;
	let signingKey;
	let publicKeyPath;
	let installedPublicKey;
	let otherKeyPair;

	before(async () => {
		// The keys land in a directory another suite asserts is empty, so they must come back out —
		// see testUtils.installTestJwtKeys. It also resolves the keys directory from the base path
		// current at call time, which is what makes this suite order-independent in the full run.
		removeJwtKeys = testUtils.installTestJwtKeys();
		clearJWTRSAKeysCache();

		const keysDir = path.join(env.getHdbBasePath(), LICENSE_KEY_DIR_NAME);
		publicKeyPath = path.join(keysDir, JWT_ENUM.JWT_PUBLIC_KEY_NAME);
		installedPublicKey = fs.readFileSync(publicKeyPath, 'utf8');
		// Sign with the exact keys validateOperationToken will verify against.
		signingKey = {
			key: fs.readFileSync(path.join(keysDir, JWT_ENUM.JWT_PRIVATE_KEY_NAME), 'utf8'),
			passphrase: fs.readFileSync(path.join(keysDir, JWT_ENUM.JWT_PASSPHRASE_NAME), 'utf8'),
		};
		otherKeyPair = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		});

		await setUsersWithRolesCache(new Map(KNOWN_USER));
	});

	after(async () => {
		removeJwtKeys();
		clearJWTRSAKeysCache();
		await setUsersWithRolesCache(new Map());
	});

	// The internal-fault cases replace the installed public key in place; restore it so each case
	// starts from usable key material without touching any file installTestJwtKeys does not own.
	beforeEach(() => {
		fs.writeFileSync(publicKeyPath, installedPublicKey);
		clearJWTRSAKeysCache();
	});

	function sign(claims, options = {}, key = signingKey) {
		return jwt.sign(claims, key, { algorithm: 'RS256', ...options });
	}

	function replacePublicKey(publicKeyMaterial) {
		fs.writeFileSync(publicKeyPath, publicKeyMaterial);
		clearJWTRSAKeysCache();
	}

	describe('tagged credential rejections', () => {
		it('classifies a syntactically malformed token as a rejection', async () => {
			const error = await raisedBy(() => validateOperationToken('not-a-jwt'));

			assert.strictEqual(isCredentialRejection(error), true);
			assert.strictEqual(error.message, 'invalid token');
			assert.strictEqual(error.statusCode, 401);
		});

		it('classifies a signature forged with another key as a rejection', async () => {
			const forged = sign({ username: 'known_user' }, { subject: 'operation' }, otherKeyPair.privateKey);

			const error = await raisedBy(() => validateOperationToken(forged));

			assert.strictEqual(isCredentialRejection(error), true);
			assert.strictEqual(error.message, 'invalid token');
		});

		it('classifies a wrong-subject token as a rejection', async () => {
			// A refresh token replayed on the operation-token path.
			const refreshToken = sign({ username: 'known_user' }, { subject: 'refresh' });

			const error = await raisedBy(() => validateOperationToken(refreshToken));

			assert.strictEqual(isCredentialRejection(error), true);
			assert.strictEqual(error.message, 'invalid token');
		});

		it('classifies an expired token as a rejection', async () => {
			const expired = sign({ username: 'known_user' }, { subject: 'operation', expiresIn: '-1s' });

			const error = await raisedBy(() => validateOperationToken(expired));

			assert.strictEqual(isCredentialRejection(error), true);
			assert.strictEqual(error.message, 'token expired');
			assert.strictEqual(error.statusCode, 403);
		});

		it('classifies a not-yet-valid token as a rejection', async () => {
			const notYet = sign({ username: 'known_user' }, { subject: 'operation', notBefore: '1h' });

			const error = await raisedBy(() => validateOperationToken(notYet));

			assert.strictEqual(isCredentialRejection(error), true);
			assert.strictEqual(error.message, 'invalid token');
		});

		it('classifies a deactivated user as a credential-state rejection', async () => {
			// The credential itself is unacceptable — the signature is genuine but the account is not
			// usable — so this is a rejection, not a fault, even though it arises inside the user store.
			await setUsersWithRolesCache(new Map([['retired_user', { username: 'retired_user', active: false }]]));
			try {
				const token = sign({ username: 'retired_user' }, { subject: 'operation' });

				const error = await raisedBy(() => validateOperationToken(token));

				assert.strictEqual(isCredentialRejection(error), true);
			} finally {
				await setUsersWithRolesCache(new Map(KNOWN_USER));
			}
		});

		it('classifies a refresh token whose stored hash does not match as a rejection', async () => {
			const refreshToken = sign({ username: 'known_user' }, { subject: 'refresh' });

			const error = await raisedBy(() => validateRefreshToken(refreshToken));

			assert.strictEqual(isCredentialRejection(error), true);
			assert.strictEqual(error.message, 'invalid token');
		});

		it('accepts a well-formed operation token, so the rejection cases mean something', async () => {
			const valid = sign({ username: 'known_user' }, { subject: 'operation' });

			const user = await validateOperationToken(valid);

			assert.strictEqual(user.username, 'known_user');
		});
	});

	describe('internal faults', () => {
		it('fails a non-PEM public key closed instead of reporting an invalid token', async () => {
			const valid = sign({ username: 'known_user' }, { subject: 'operation' });
			replacePublicKey('this is not key material');

			const error = await raisedBy(() => validateOperationToken(valid));

			assert.strictEqual(isCredentialRejection(error), false);
			assert.notStrictEqual(error.message, 'invalid token');
			assert.strictEqual(error.statusCode, 500);
		});

		it('fails a PEM-shaped but corrupt public key closed', async () => {
			// The decisive case: `jsonwebtoken` reports unusable key material through the very same
			// `JsonWebTokenError` type it uses for a forged token, so the name alone cannot classify it.
			const valid = sign({ username: 'known_user' }, { subject: 'operation' });
			replacePublicKey('-----BEGIN PUBLIC KEY-----\nbm90LWEtcmVhbC1rZXk=\n-----END PUBLIC KEY-----\n');

			const error = await raisedBy(() => validateOperationToken(valid));

			assert.strictEqual(isCredentialRejection(error), false, `unexpectedly tagged: ${error.message}`);
			assert.notStrictEqual(error.message, 'invalid token');
		});

		it('propagates a user-store fault raised while resolving a validly signed token', async () => {
			// `findAndValidateUser()` reaches storage through the user cache; a failure there is a
			// Harper-side fault even when it arrives with a 4xx status.
			const failingCache = {
				get() {
					const error = new Error('Table system.hdb_user not found');
					error.statusCode = 400;
					throw error;
				},
			};
			await setUsersWithRolesCache(failingCache);
			try {
				const valid = sign({ username: 'known_user' }, { subject: 'operation' });

				const error = await raisedBy(() => validateOperationToken(valid));

				assert.strictEqual(isCredentialRejection(error), false);
				assert.strictEqual(error.message, 'Table system.hdb_user not found');
			} finally {
				await setUsersWithRolesCache(new Map(KNOWN_USER));
			}
		});
	});
});
