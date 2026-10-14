'use strict';

// GHSA: `describe_all` built its result as a plain object keyed by database name, and each
// per-database object the same way. A database named `__proto__` is not null on a plain object —
// it is `Object.prototype` — so the `map[name] == null` guard is skipped and `map[name][table] = …`
// writes each of that database's tables onto the process-wide `Object.prototype`, keyed by table
// name. These tests drive the REAL `describeAll` (and the REAL `verifyPerms`) over an injected
// `__proto__` database and assert nothing escapes onto `Object.prototype`.
//
// Injection mirrors the existing `describeAll authorization bypass state` test in
// schemaDescribe.test.js: the in-memory `databases` map is `Object.create(null)`, so assigning
// `databases.__proto__` / `databases.constructor` creates an OWN enumerable key that `for..in`
// visits, exactly as a real database of that name would (one could be created before the name
// validators landed). A minimal stand-in Table is enough — `descTable` tolerates the missing store
// (its stat/count reads are wrapped in try/catch) and returns a result carrying the schema and the
// table's own `tableName`, which is all the vulnerable output-building loop consumes.

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const schema_describe = require('#src/dataLayer/schemaDescribe');
const { databases, getDatabases } = require('#src/resources/databases');
const operationAuthorizationState = require('#src/server/serverHelpers/operationAuthorizationState');
const op_auth = require('#src/utility/operation_authorization');

// `insertData` is the internal handler name the `insert` operation resolves to in verifyPerms.
const INSERT_FN = 'insertData';

function fakeTable(tableName) {
	return {
		tableName,
		attributes: [],
		audit: false,
		schemaDefined: true,
		// Not a RocksDatabase, and the path does not exist, so descTable's size/stat reads throw and
		// are swallowed — the result still carries `schema` and `name`, which is all we need.
		primaryStore: { path: '/harper-unit-test/no-such-store' },
	};
}

/** Enumerate an object's own + inherited keys that `in` / plain reads would resolve to pollution. */
function prototypeIsClean() {
	return (
		!('super_user' in Object.prototype) &&
		!('polluted_marker' in Object.prototype) &&
		Object.getPrototypeOf({}) === Object.prototype
	);
}

function scrubPrototype() {
	delete Object.prototype.super_user;
	delete Object.prototype.polluted_marker;
}

describe('describe_all prototype pollution (GHSA)', function () {
	beforeEach(function () {
		getDatabases();
		scrubPrototype();
	});

	afterEach(function () {
		delete databases.__proto__;
		delete databases.constructor;
		delete databases.safe_db;
		delete Object.polluted_marker;
		scrubPrototype();
	});

	it("does not write a `__proto__` database's tables onto Object.prototype", async function () {
		// A database literally named `__proto__`, holding a table, as a structure user could have
		// created before the name validators rejected it.
		databases.__proto__ = { polluted_marker: fakeTable('polluted_marker') };

		const result = await operationAuthorizationState.runWithOperationAuthorizationBypass(true, () =>
			schema_describe.describeAll({ operation: 'describe_all' })
		);

		// The describe still reports the database (as an own key of its null-prototype result)…
		assert.ok(Object.hasOwn(result, '__proto__'), 'the __proto__ database should appear as an own key');
		// …but nothing reached Object.prototype: a brand-new, unrelated object has not gained the key.
		assert.strictEqual({}.polluted_marker, undefined, 'Object.prototype was polluted with the table key');
		assert.ok(prototypeIsClean(), 'Object.prototype must be untouched');
	});

	it('does not pollute the Object constructor through a `constructor` database', async function () {
		// A `constructor`-named database resolves `hdbDescription['constructor']` to the Object function
		// itself, so the vulnerable build writes the table key onto `Object` (a different global than
		// Object.prototype, but still process-wide shared state).
		databases.constructor = { polluted_marker: fakeTable('polluted_marker') };

		await operationAuthorizationState.runWithOperationAuthorizationBypass(true, () =>
			schema_describe.describeAll({ operation: 'describe_all' })
		);

		assert.strictEqual(
			Object.polluted_marker,
			undefined,
			'the Object constructor was mutated via a constructor database'
		);
		assert.strictEqual({}.polluted_marker, undefined, 'Object.prototype was polluted via constructor');
		assert.ok(prototypeIsClean(), 'Object.prototype must be untouched');
	});

	it('builds each per-database object with a null prototype so a `__proto__` table cannot reparent it', async function () {
		// The per-database object is also keyed by table name. A table named `__proto__` inside an
		// otherwise normal database would, on a plain `{}`, reparent the returned per-database object to
		// the table's describe result (`perDb['__proto__'] = result` invokes the setter). Build it with
		// Object.create(null) so that becomes an ordinary own key and the response shape stays sane.
		const perDb = Object.create(null);
		perDb.__proto__ = fakeTable('__proto__'); // own key on a null-prototype map, as a real load would hold
		databases.safe_db = perDb;

		const result = await operationAuthorizationState.runWithOperationAuthorizationBypass(true, () =>
			schema_describe.describeAll({ operation: 'describe_all' })
		);

		assert.strictEqual(
			Object.getPrototypeOf(result.safe_db),
			null,
			'the per-database describe object was reparented by a `__proto__` table'
		);
		assert.ok(Object.hasOwn(result.safe_db, '__proto__'), 'the `__proto__` table should be an own key of its database');
	});

	// The escalation question the advisory left open: a structure user creates database `__proto__`
	// with a table named `super_user`; a describe runs; then a non-super-user's request is authorized.
	// If the describe wrote `Object.prototype.super_user`, the super-user check
	// (`!!hdb_user.role.permission.super_user`, read before the permissions translator runs) reads the
	// polluted value for any role whose permission object has no OWN `super_user` key.
	it('does not let a `__proto__`/`super_user` describe escalate a structure user', async function () {
		databases.__proto__ = { super_user: fakeTable('super_user') };

		await operationAuthorizationState.runWithOperationAuthorizationBypass(true, () =>
			schema_describe.describeAll({ operation: 'describe_all' })
		);

		// A structure-user role with NO own super_user key, performing an ordinary table insert that
		// structure_user alone does not grant.
		const request = {
			operation: 'insert',
			schema: 'data',
			table: 'dog',
			records: [],
			hdb_user: { username: 'struct', role: { role: 'struct_role', permission: { structure_user: true } } },
		};

		// verifyPerms returns null/undefined when it authorizes, or a denial response object otherwise.
		const decision = op_auth.verifyPerms(request, INSERT_FN);
		const authorizedAsSuperUser = decision === null || decision === undefined;

		assert.strictEqual(
			authorizedAsSuperUser,
			false,
			'a polluted Object.prototype.super_user escalated a structure user to super user'
		);
		assert.ok(prototypeIsClean(), 'Object.prototype must be untouched');
	});
});
