'use strict';

// The narrowing contract for a token-scoped operation allowlist: it may only ever subtract from what
// the user's role allows, and it must not be bypassable by any of verifyPerms' early-return paths.

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const opAuth = require('#src/utility/operation_authorization');

// `insertData` is the internal function name for the `insert` operation; verifyPerms resolves the
// api_name via the permission registry, which is what a scope is written against.
const INSERT_FN = 'insertData';

function requestAs(permission, tokenOperations) {
	const hdb_user = { username: 'ci-deploy', role: { role: 'r', permission } };
	if (tokenOperations !== undefined) hdb_user.tokenOperations = tokenOperations;
	return { operation: 'insert', schema: 'data', table: 'dog', hdb_user, records: [] };
}

/** verifyPerms returns null when allowed, or a response object describing the denial. */
function isAllowed(result) {
	return result === null || result === undefined;
}

describe('token-scoped operation narrowing', () => {
	it('allows an operation inside the scope', () => {
		const result = opAuth.verifyPerms(requestAs({ super_user: true }, ['insert']), INSERT_FN);
		assert.ok(isAllowed(result), 'expected the in-scope operation to be permitted');
	});

	it('denies an operation outside the scope', () => {
		const result = opAuth.verifyPerms(requestAs({ super_user: true }, ['get_status']), INSERT_FN);
		assert.ok(!isAllowed(result), 'expected the out-of-scope operation to be denied');
	});

	// The whole point: a super_user returns null early in verifyPerms, so a narrowing check placed
	// after that bypass would do nothing for exactly the identity that most needs constraining.
	it('constrains a super_user', () => {
		assert.ok(!isAllowed(opAuth.verifyPerms(requestAs({ super_user: true }, ['get_status']), INSERT_FN)));
	});

	// Gate 2 treats an explicit SU-only listing in role.permission.operations as a deliberate grant
	// and returns null. The scope must still win.
	it('constrains an operation the role granted through its own operations allowlist', () => {
		const permission = { super_user: false, operations: ['insert'] };
		assert.ok(!isAllowed(opAuth.verifyPerms(requestAs(permission, ['get_status']), INSERT_FN)));
	});

	// Narrowing only: naming an operation the role forbids must not grant it.
	it('does not grant an operation the role forbids', () => {
		const permission = { super_user: false, operations: ['get_status'] };
		const result = opAuth.verifyPerms(requestAs(permission, ['insert']), INSERT_FN);
		assert.ok(!isAllowed(result), 'a scope must never widen the role');
	});

	it('is inert when the token carries no scope', () => {
		assert.ok(isAllowed(opAuth.verifyPerms(requestAs({ super_user: true }), INSERT_FN)));
	});

	// A group name must be expanded rather than compared literally, or naming one would deny
	// everything. `read_only` deliberately excludes insert, so it also proves the expansion narrows.
	it('expands operation groups', () => {
		const withGroup = requestAs({ super_user: true }, ['read_only']);
		const result = opAuth.verifyPerms(withGroup, INSERT_FN);

		assert.ok(withGroup.hdb_user._expandedTokenOperations.size > 1, 'expected the group to expand');
		assert.ok(withGroup.hdb_user._expandedTokenOperations.has('search_by_value'), 'expected group members');
		assert.ok(!isAllowed(result), 'read_only must not admit insert');
	});

	it('memoizes the expansion on the user', () => {
		const request = requestAs({ super_user: true }, ['insert']);
		opAuth.verifyPerms(request, INSERT_FN);
		const first = request.hdb_user._expandedTokenOperations;
		opAuth.verifyPerms(request, INSERT_FN);
		assert.strictEqual(request.hdb_user._expandedTokenOperations, first, 'expected one expansion');
	});

	it('denies everything when the scope is empty', () => {
		assert.ok(!isAllowed(opAuth.verifyPerms(requestAs({ super_user: true }, []), INSERT_FN)));
	});
});
