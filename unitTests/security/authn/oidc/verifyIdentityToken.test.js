'use strict';

const assert = require('node:assert');
const { generateKeyPairSync, createPublicKey } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { verifyIdentityToken } = require('#src/security/authn/oidc/identityToken');

const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'https://my-instance.harperdb.io:9925/';
const SIGNING_KID = 'test-signing-key';

// Fixed clock so expiry assertions do not depend on how long the suite takes to run.
const NOW_SECONDS = 1_800_000_000;

describe('verifyIdentityToken', () => {
	let privateKey;
	let publicKey;
	let otherPrivateKey;

	before(() => {
		const pair = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		});
		privateKey = pair.privateKey;
		publicKey = pair.publicKey;
		otherPrivateKey = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		}).privateKey;
	});

	// Stands in for the JWKS lookup so these tests exercise the real verification path without network.
	function lookupKey(issuer, kid) {
		assert.strictEqual(issuer, ISSUER, 'expected the normalized issuer');
		if (kid !== SIGNING_KID) return Promise.reject(new Error(`unknown kid ${kid}`));
		return Promise.resolve(createPublicKey(publicKey));
	}

	function claimsFor(overrides = {}) {
		return {
			iss: ISSUER,
			aud: AUDIENCE,
			sub: 'repo:HarperFast/my-app:environment:production',
			jti: 'token-id-1',
			iat: NOW_SECONDS,
			exp: NOW_SECONDS + 300,
			repository: 'HarperFast/my-app',
			repository_id: '67890',
			workflow_ref: 'HarperFast/my-app/.github/workflows/deploy.yml@refs/heads/main',
			environment: 'production',
			...overrides,
		};
	}

	function sign(claims, { key = privateKey, algorithm = 'RS256', kid = SIGNING_KID } = {}) {
		return jwt.sign(claims, key, { algorithm, header: { alg: algorithm, kid } });
	}

	function verify(token, options = {}) {
		return verifyIdentityToken(
			token,
			{ issuer: ISSUER, audience: AUDIENCE },
			{ getSigningKey: lookupKey, clockTimestamp: NOW_SECONDS, ...options }
		);
	}

	async function assertRejected(token, options) {
		await assert.rejects(
			() => verify(token, options),
			(error) => {
				assert.strictEqual(error.statusCode, 401);
				// The reason belongs in the log, not in a response to an unauthenticated caller.
				assert.strictEqual(error.message, 'Identity token was rejected');
				return true;
			}
		);
	}

	it('accepts a well-formed token and returns normalized claims', async () => {
		const claims = await verify(sign(claimsFor()));
		assert.strictEqual(claims.repository_id, '67890');
		assert.strictEqual(claims.environment, 'production');
		assert.strictEqual(claims.workflow_path, 'HarperFast/my-app/.github/workflows/deploy.yml');
	});

	it('tolerates modest clock skew', async () => {
		const token = sign(claimsFor());
		// 30s past expiry is inside the 60s tolerance.
		const claims = await verify(token, { clockTimestamp: NOW_SECONDS + 330 });
		assert.strictEqual(claims.repository_id, '67890');
	});

	it('rejects an expired token', async () => {
		await assertRejected(sign(claimsFor()), { clockTimestamp: NOW_SECONDS + 3600 });
	});

	it('rejects a token issued for another audience', async () => {
		await assertRejected(sign(claimsFor({ aud: 'https://someone-elses-service.example/' })));
	});

	it('rejects a token from another issuer', async () => {
		await assertRejected(sign(claimsFor({ iss: 'https://gitlab.example.com' })));
	});

	it('rejects a token signed by a key we do not trust', async () => {
		await assertRejected(sign(claimsFor(), { key: otherPrivateKey }));
	});

	// Algorithm confusion: the public key is public, so a token HMAC-signed with it must never verify.
	it('rejects an HMAC-signed token', async () => {
		const token = jwt.sign(claimsFor(), publicKey, {
			algorithm: 'HS256',
			header: { alg: 'HS256', kid: SIGNING_KID },
		});
		await assertRejected(token);
	});

	it('rejects an unsigned token', async () => {
		const token = jwt.sign(claimsFor(), '', { algorithm: 'none', header: { alg: 'none', kid: SIGNING_KID } });
		await assertRejected(token);
	});

	it('rejects a tampered payload', async () => {
		const [header, , signature] = sign(claimsFor()).split('.');
		const forged = Buffer.from(JSON.stringify(claimsFor({ repository_id: '99999' }))).toString('base64url');
		await assertRejected(`${header}.${forged}.${signature}`);
	});

	// jsonwebtoken only enforces exp when it is present, so a token without one would never expire.
	it('rejects a token with no exp claim', async () => {
		const { exp: _exp, ...withoutExp } = claimsFor();
		await assertRejected(sign(withoutExp));
	});

	it('rejects a token whose declared lifetime exceeds the ceiling', async () => {
		await assertRejected(sign(claimsFor({ exp: NOW_SECONDS + 86_400 })));
	});

	// The ceiling is measured from `iat`, so treating `iat` as optional means a token that omits it
	// is not bounded at all — the check would skip exactly the token that most needs it. OIDC
	// requires the claim, so demanding it costs nothing.
	// The expectation handed to jwt.verify is the NORMALIZED issuer, but the comparison against `iss`
	// is byte-for-byte — so an issuer that publishes a trailing slash (Azure AD v1:
	// `https://sts.windows.net/<tenant>/`) could never authenticate. Both spellings already collapse
	// to one value everywhere else (cache key, discovery check, policy lookup), so accepting both
	// here is consistency, not widened trust.
	it('accepts a token whose iss carries a trailing slash', async () => {
		const claims = await verify(sign(claimsFor({ iss: `${ISSUER}/` })));
		assert.strictEqual(claims.repository, 'HarperFast/my-app');
	});

	it('still rejects a token from a different issuer', async () => {
		await assertRejected(sign(claimsFor({ iss: 'https://evil.example.com' })));
	});

	it('rejects a token with no iat claim', async () => {
		const { iat: _iat, ...withoutIat } = claimsFor({ exp: NOW_SECONDS + 86_400 });
		await assertRejected(sign(withoutIat));
	});

	// jsonwebtoken validates exp and nbf but never rejects a future iat. Shifting the whole pair
	// forward keeps `exp - iat` under the ceiling while leaving the token usable for a day, so the
	// distance from the verification clock to `exp` has to be bounded independently.
	it('rejects a token whose iat and exp are both shifted into the future', async () => {
		const shifted = claimsFor({ iat: NOW_SECONDS + 86_400, exp: NOW_SECONDS + 86_700 });
		await assertRejected(sign(shifted));
	});

	// Genuine clock skew is not an attack: an iat inside the tolerance still verifies.
	it('accepts an iat slightly ahead of the verification clock', async () => {
		const claims = await verify(sign(claimsFor({ iat: NOW_SECONDS + 30, exp: NOW_SECONDS + 300 })));
		assert.strictEqual(claims.repository, 'HarperFast/my-app');
	});

	// Replay is keyed on a hash of the token itself, so `jti` is not required — which is what lets
	// issuers that use `uti` (Azure) or omit it entirely work with no provider code.
	it('accepts a token with no jti claim', async () => {
		const { jti: _jti, ...withoutJti } = claimsFor();
		const claims = await verify(sign(withoutJti));
		assert.strictEqual(claims.repository_id, '67890');
		assert.strictEqual(claims.jti, undefined);
	});

	it('rejects a token whose kid is unknown to the key lookup', async () => {
		await assert.rejects(() => verify(sign(claimsFor(), { kid: 'rotated-away' })), /unknown kid/);
	});

	it('rejects malformed input', async () => {
		for (const value of ['', 'not-a-jwt', null, undefined, 42]) {
			await assert.rejects(() => verify(value), 'expected rejection for ' + JSON.stringify(value));
		}
	});

	it('requires an https issuer', async () => {
		await assert.rejects(
			() =>
				verifyIdentityToken(
					sign(claimsFor()),
					{ issuer: 'http://token.actions.githubusercontent.com', audience: AUDIENCE },
					{ getSigningKey: lookupKey, clockTimestamp: NOW_SECONDS }
				),
			/https/
		);
	});

	it('requires an audience', async () => {
		await assert.rejects(
			() =>
				verifyIdentityToken(
					sign(claimsFor()),
					{ issuer: ISSUER, audience: '' },
					{ getSigningKey: lookupKey, clockTimestamp: NOW_SECONDS }
				),
			/audience is required/
		);
	});
});
