'use strict';

// descTable tolerates a stand-in table with no store, so an own `databases.__proto__` entry is enough to drive describeAll.

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const schema_describe = require('#src/dataLayer/schemaDescribe');
const { databases, getDatabases } = require('#src/resources/databases');
const operationAuthorizationState = require('#src/server/serverHelpers/operationAuthorizationState');
const op_auth = require('#src/utility/operation_authorization');

const INSERT_FN = 'insertData';

function fakeTable(tableName) {
	return {
		tableName,
		attributes: [],
		audit: false,
		schemaDefined: true,
		primaryStore: { path: '/harper-unit-test/no-such-store' },
	};
}

function describeAllAsSystem() {
	return operationAuthorizationState.runWithOperationAuthorizationBypass(true, () =>
		schema_describe.describeAll({ operation: 'describe_all' })
	);
}

function prototypeIsClean() {
	return (
		!('super_user' in Object.prototype) &&
		!('polluted_marker' in Object.prototype) &&
		Object.getPrototypeOf({}) === Object.prototype
	);
}

describe('describe_all prototype pollution', function () {
	beforeEach(function () {
		getDatabases();
	});

	afterEach(function () {
		delete databases.__proto__;
		delete databases.constructor;
		delete databases.safe_db;
		delete Object.polluted_marker;
		delete Object.prototype.super_user;
		delete Object.prototype.polluted_marker;
	});

	it("does not write a `__proto__` database's tables onto Object.prototype", async function () {
		databases.__proto__ = { polluted_marker: fakeTable('polluted_marker') };

		const result = await describeAllAsSystem();

		assert.ok(Object.hasOwn(result, '__proto__'), 'the __proto__ database should appear as an own key');
		assert.strictEqual({}.polluted_marker, undefined, 'Object.prototype was polluted with the table key');
		assert.ok(prototypeIsClean(), 'Object.prototype must be untouched');
	});

	it("does not write a `constructor` database's tables onto the Object constructor", async function () {
		databases.constructor = { polluted_marker: fakeTable('polluted_marker') };

		await describeAllAsSystem();

		assert.strictEqual(Object.polluted_marker, undefined, 'the Object constructor was mutated');
		assert.ok(prototypeIsClean(), 'Object.prototype must be untouched');
	});

	it('does not let a `__proto__` table reparent its per-database describe object', async function () {
		const perDb = Object.create(null);
		perDb.__proto__ = fakeTable('__proto__');
		databases.safe_db = perDb;

		const result = await describeAllAsSystem();

		assert.strictEqual(Object.getPrototypeOf(result.safe_db), null, 'the per-database object was reparented');
		assert.ok(Object.hasOwn(result.safe_db, '__proto__'), 'the `__proto__` table should be an own key');
	});

	it('does not let a `__proto__` database with a `super_user` table escalate a structure user', async function () {
		databases.__proto__ = { super_user: fakeTable('super_user') };

		await describeAllAsSystem();

		const request = {
			operation: 'insert',
			schema: 'data',
			table: 'dog',
			records: [],
			hdb_user: { username: 'struct', role: { role: 'struct_role', permission: { structure_user: true } } },
		};
		const decision = op_auth.verifyPerms(request, INSERT_FN);

		assert.notStrictEqual(decision ?? null, null, 'a structure user was authorized as a super user');
		assert.ok(prototypeIsClean(), 'Object.prototype must be untouched');
	});
});
