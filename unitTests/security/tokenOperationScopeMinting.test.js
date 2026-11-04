'use strict';

// The mint side of the narrowing contract. Kept separate from tokenOperationScope.test.js because
// this needs real JWT signing keys, and the point of these cases is the *round trip*: a scope that
// survives verifyPerms in isolation is worthless if createOperationToken drops it on the way out.

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { createOperationToken, clearJWTRSAKeysCache } = require('#src/security/tokenAuthentication');

function payloadOf(token) {
	return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

describe('operation scope on a minted token', () => {
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

	it('carries a scope', async () => {
		const token = await createOperationToken({ ...user, operations: ['deploy_component'] }, 3600);
		assert.deepStrictEqual(payloadOf(token).operations, ['deploy_component']);
	});

	// The bug this exists to prevent: an empty scope means "no operations". A truthiness check on
	// length drops the claim, which leaves the token UNSCOPED — a security control failing open.
	it('carries an empty scope rather than dropping it', async () => {
		const token = await createOperationToken({ ...user, operations: [] }, 3600);
		assert.deepStrictEqual(payloadOf(token).operations, [], 'an empty scope must not become an absent scope');
	});

	it('omits the claim when there is no scope', async () => {
		for (const operations of [undefined, null]) {
			const token = await createOperationToken({ ...user, operations }, 3600);
			assert.strictEqual(payloadOf(token).operations, undefined);
		}
	});
});
