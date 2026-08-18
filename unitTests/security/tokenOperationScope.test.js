'use strict';

// The narrowing contract for a token-scoped operation allowlist: it may only ever subtract from what
// the user's role allows, and it must not be bypassable by any of verifyPerms' early-return paths.

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const opAuth = require('#src/utility/operation_authorization');
const sql = require('#src/sqlTranslator/index');

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

	// A null scope is what an unscoped policy stores; it must fall through to the role, not throw.
	it('falls through to the role when the scope is null', () => {
		assert.ok(isAllowed(opAuth.verifyPerms(requestAs({ super_user: true }, null), INSERT_FN)));
	});

	it('denies everything when the scope is empty', () => {
		assert.ok(!isAllowed(opAuth.verifyPerms(requestAs({ super_user: true }, []), INSERT_FN)));
	});
});

// `sql` dispatches to verifyPermsAST, in a branch mutually exclusive with the verifyPerms call in
// chooseOperation. A gate in only one of them lets a token scoped to e.g. get_status run arbitrary
// SQL against whatever its role can reach — which would falsify the whole "can only subtract" claim.
// The scope is written in API-operation names (`deploy_component`), which is what the caller sends as
// `operation`. verifyPerms must gate on that, not on the handler function name — deployComponent has
// no api_name mapping, so gating on the handler denied the feature's own headline operation.
describe('token scope gates on the API operation, not the handler name', () => {
	function requestFor(operation, tokenOperations) {
		const hdb_user = { username: 'ci-deploy', role: { role: 'r', permission: { super_user: true } } };
		if (tokenOperations !== undefined) hdb_user.tokenOperations = tokenOperations;
		return { operation, hdb_user };
	}

	it('allows deploy_component when the scope names it', () => {
		// deployComponent (the handler) has no api_name; the scope names the API op `deploy_component`.
		const result = opAuth.verifyPerms(requestFor('deploy_component', ['deploy_component']), 'deployComponent');
		assert.ok(isAllowed(result), 'a token scoped to deploy_component must be able to deploy_component');
	});

	it('denies deploy_component when the scope does not name it', () => {
		const result = opAuth.verifyPerms(requestFor('deploy_component', ['get_status']), 'deployComponent');
		assert.ok(!isAllowed(result));
	});

	// Shared-handler aliases must be distinguished by the API op, not conflated by handler name.
	it('distinguishes shared-handler aliases (search_by_id vs search_by_value)', () => {
		const allowed = opAuth.verifyPerms(requestFor('search_by_id', ['search_by_id']), 'searchByHash');
		assert.ok(isAllowed(allowed), 'search_by_id is in scope');
		const denied = opAuth.verifyPerms(requestFor('search_by_value', ['search_by_id']), 'searchByHash');
		assert.ok(!isAllowed(denied), 'search_by_value is not in scope even though it shares a handler');
	});

	// A job (export_local/export_to_s3) is dispatched with its nested search_operation as requestJson,
	// so the scope must gate the top-level op passed via options.apiOperation, not the inner search —
	// otherwise a read-scoped token could exfiltrate data through an export.
	it('gates a non-SQL export job on the export operation, not the nested search', () => {
		const jobRequest = (tokenOperations) => ({
			operation: 'search_by_conditions', // the nested op the dispatcher hands verifyPerms
			hdb_user: { username: 'ci-deploy', role: { role: 'r', permission: { super_user: true } }, tokenOperations },
		});
		const denied = opAuth.verifyPerms(jobRequest(['search_by_conditions']), 'searchByConditions', {
			apiOperation: 'export_local',
		});
		assert.ok(!isAllowed(denied), 'a search-scoped token must not be able to run export_local');

		const allowed = opAuth.verifyPerms(jobRequest(['export_local']), 'searchByConditions', {
			apiOperation: 'export_local',
		});
		assert.ok(isAllowed(allowed), 'an export_local-scoped token may run the export');
	});
});

describe('token-scoped narrowing on the SQL path', () => {
	function userWithScope(permission, tokenOperations) {
		const user = { username: 'ci-deploy', role: { role: 'r', permission } };
		if (tokenOperations !== undefined) user.tokenOperations = tokenOperations;
		return user;
	}

	function checkSql(statement, user, operation = 'sql') {
		const parsed = sql.convertSQLToAST(statement);
		return sql.checkASTPermissions({ operation, sql: statement, hdb_user: user }, parsed);
	}

	it('denies SQL when the scope does not include it', () => {
		const denial = checkSql('SELECT * FROM data.dog', userWithScope({ super_user: true }, ['get_status']));
		assert.ok(denial, 'a token scoped away from sql must not be able to run SQL');
	});

	// `api_operation` is how a job tells this check which top-level operation it was invoked as. For a
	// direct `sql` call the request IS the client's body, so if that field were read from the body a
	// caller could name any operation their scope happens to allow and run arbitrary SQL under it —
	// and on this path checkASTPermissions is the ONLY gate, since the sql branch of chooseOperation
	// is mutually exclusive with verifyPerms. It must never be honored from an inbound request.
	it('ignores a caller-supplied api_operation on a direct SQL call', () => {
		const user = userWithScope({ super_user: true }, ['deploy_component']);
		const parsed = sql.convertSQLToAST('SELECT * FROM data.dog');
		const denial = sql.checkASTPermissions(
			{ operation: 'sql', sql: 'SELECT * FROM data.dog', api_operation: 'deploy_component', hdb_user: user },
			parsed
		);
		assert.ok(denial, 'a body-supplied api_operation must not satisfy the scope gate');
	});

	// The dangerous case: verifyPermsAST returns null unconditionally for a super_user.
	it('denies a super_user whose scope excludes SQL', () => {
		const denial = checkSql('DELETE FROM data.dog', userWithScope({ super_user: true }, ['deploy_component']));
		assert.ok(denial, 'the super_user bypass must not outrank the token scope');
	});

	it('allows SQL when the scope includes it', () => {
		const denial = checkSql('SELECT * FROM data.dog', userWithScope({ super_user: true }, ['sql']));
		assert.strictEqual(denial, null, 'an in-scope sql statement should reach the normal perms checks');
	});

	it('allows SQL through a group that contains it', () => {
		const denial = checkSql('SELECT * FROM data.dog', userWithScope({ super_user: true }, ['read_only']));
		assert.strictEqual(denial, null);
	});

	// `read_only` expands to include `sql` — the group defers DML enforcement to table CRUD perms —
	// but verifyPermsAST returns null outright for a super_user before any table check runs. Without
	// a variant check, a token scoped to `read_only` could DELETE: the one thing that name promises
	// it cannot do. A write statement must additionally name its matching data operation.
	for (const statement of [
		'DELETE FROM data.dog',
		"UPDATE data.dog SET name = 'x'",
		'INSERT INTO data.dog (id) VALUES (1)',
	]) {
		const variant = statement.split(' ')[0].toLowerCase();

		it(`denies ${variant} SQL for a read_only scope, even for a super_user`, () => {
			const denial = checkSql(statement, userWithScope({ super_user: true }, ['read_only']));
			assert.ok(denial, `read_only must not admit ${variant} through SQL`);
		});

		// The same statement is admitted once the scope names the data operation — this is what
		// separates read_only from standard_user without tracking which group admitted `sql`.
		it(`allows ${variant} SQL when the scope names the data operation`, () => {
			const denial = checkSql(statement, userWithScope({ super_user: true }, ['sql', variant]));
			assert.strictEqual(denial, null, `a scope naming ${variant} may run it`);
		});

		// A write-capable non-SU role is bound by the scope too: the role permitting the write is
		// not the question, the credential's scope is.
		it(`denies ${variant} SQL for a write-capable non-super-user outside the scope`, () => {
			const permission = { super_user: false, operations: ['sql', variant] };
			assert.ok(checkSql(statement, userWithScope(permission, ['read_only'])));
		});
	}

	it('allows write SQL through standard_user, which names the data operations', () => {
		const denial = checkSql('DELETE FROM data.dog', userWithScope({ super_user: true }, ['standard_user']));
		assert.strictEqual(denial, null);
	});

	// A bare ['sql'] grants the SQL interface, not unrestricted DML through it.
	it('admits SELECT but not DELETE for a bare sql scope', () => {
		assert.strictEqual(checkSql('SELECT * FROM data.dog', userWithScope({ super_user: true }, ['sql'])), null);
		assert.ok(checkSql('DELETE FROM data.dog', userWithScope({ super_user: true }, ['sql'])));
	});

	// An unscoped token is unaffected: the variant gate only ever narrows a scope that exists.
	it('is inert for write SQL when the token carries no scope', () => {
		assert.strictEqual(checkSql('DELETE FROM data.dog', userWithScope({ super_user: true })), null);
	});

	it('is inert for a token with no scope', () => {
		const denial = checkSql('SELECT * FROM data.dog', userWithScope({ super_user: true }));
		assert.strictEqual(denial, null);
	});

	it('gates a nested-SQL export job on the export operation, not on `sql`', () => {
		// export_local carries its query as SQL, but the scope names the job, not `sql`. A token scoped
		// only to `sql` must not be able to start an export it was never granted.
		const deniedUser = userWithScope({ super_user: true }, ['sql']);
		const denied = checkSql('SELECT * FROM data.dog', deniedUser, 'export_local');
		assert.ok(denied, 'export_local is outside a `sql`-only scope');

		const allowedUser = userWithScope({ super_user: true }, ['export_local']);
		const allowed = checkSql('SELECT * FROM data.dog', allowedUser, 'export_local');
		assert.strictEqual(allowed, null, 'an export_local-scoped token may run the export');
	});
});
