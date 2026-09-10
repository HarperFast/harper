'use strict';

// A credential minted from a workload identity exchange (#2171) must not be tradeable for a
// longer-lived one. `create_authentication_tokens` is the path that makes that possible and does not
// look like it: it is NO_AUTH, but serverHandlers.js special-cases a call with no username/password
// to authenticate by Bearer token instead — so an exchanged token is accepted there in place of a
// password, honors a caller-supplied `expires_in`, and returns a 30-day refresh token.
//
// These cases need no stubbing because createTokens refuses ahead of the user lookup: the guard
// reads only the caller's principal, so a refused request costs no database read and writes nothing.

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { createTokens, createOperationToken, clearJWTRSAKeysCache } = require('#src/security/tokenAuthentication');
const { WORKLOAD_IDENTITY_CLAIM, attachWorkloadIdentityToUser } = require('#src/security/credentialProvenance');

function payloadOf(token) {
	return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

/** createTokens must reject with 403 — and reach neither the key material nor the user record. */
async function assertDenied(authObj, message) {
	await assert.rejects(
		() => createTokens(authObj),
		(e) => {
			assert.strictEqual(e.statusCode, 403, message);
			return true;
		},
		message
	);
}

describe('workload identity provenance blocks credential minting', () => {
	// The case a scope-only guard misses: a trust policy names `operations` only when the operator
	// opts in, so the ORDINARY exchanged token is unscoped. This is the PR's own headline example.
	it('denies an unscoped workload identity caller', async () => {
		await assertDenied(
			{
				expires_in: '3650d', // the lifetime extension the denial exists to prevent
				hdb_user: { username: 'HDB_USER', fromWorkloadIdentity: true },
			},
			'an unscoped workload token must not mint standing credentials'
		);
	});

	it('denies a scoped workload identity caller', async () => {
		await assertDenied({
			hdb_user: { username: 'HDB_USER', fromWorkloadIdentity: true, tokenOperations: ['deploy_component'] },
		});
	});

	// A session is minted from a username alone, so it cannot be narrowed after the fact — the guard
	// has to sit ahead of the `purpose` branch, not inside the standing-credential path.
	it('denies the login path too', async () => {
		await assertDenied({ purpose: 'login', hdb_user: { username: 'HDB_USER', fromWorkloadIdentity: true } });
	});

	// Provenance is independent of scope, but a scoped credential from any other source is still
	// refused — that guard predates this one and both are load-bearing.
	it('denies a scoped caller regardless of provenance', async () => {
		await assertDenied({ hdb_user: { username: 'HDB_USER', tokenOperations: ['deploy_component'] } });
	});

	it('denies a deny-all ([]) scope, which is a scope and not the absence of one', async () => {
		await assertDenied({ hdb_user: { username: 'HDB_USER', tokenOperations: [] } });
	});

	// Strict `=== true`, so a truthy value on a user record cannot be coerced into provenance and a
	// falsy one cannot silently drop it.
	it('treats only a literal true as provenance', () => {
		for (const claim of [false, undefined, null, 'true', 1, {}]) {
			const user = attachWorkloadIdentityToUser({}, claim);
			assert.strictEqual(user.fromWorkloadIdentity, undefined, `${JSON.stringify(claim)} must not mark a principal`);
		}
		assert.strictEqual(attachWorkloadIdentityToUser({}, true).fromWorkloadIdentity, true);
	});
});

describe('provenance on a minted token', () => {
	const user = { username: 'ci-deploy', super_user: false };
	let removeJwtKeys;

	before(() => {
		// The keys land in a directory another suite asserts is empty, so they must come back out —
		// see testUtils.installTestJwtKeys.
		removeJwtKeys = testUtils.installTestJwtKeys();
		clearJWTRSAKeysCache();
	});

	after(() => {
		removeJwtKeys();
		clearJWTRSAKeysCache();
	});

	// Signed with the rest of the payload: a caller cannot strip the claim to look password-minted.
	it('stamps every token createOperationToken mints', async () => {
		const token = await createOperationToken({ ...user, operations: ['deploy_component'] }, 3600);
		assert.strictEqual(payloadOf(token)[WORKLOAD_IDENTITY_CLAIM], true);
	});

	// Unconditional, because the function mints without a password in every case — an unscoped
	// exchanged token needs the marker just as much as a scoped one.
	it('stamps an unscoped token too', async () => {
		const token = await createOperationToken(user, 3600);
		assert.strictEqual(payloadOf(token)[WORKLOAD_IDENTITY_CLAIM], true);
		assert.strictEqual(payloadOf(token).operations, undefined, 'this token carries no scope to rely on');
	});
});
