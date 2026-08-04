'use strict';

/**
 * Collision identity for reserved (non-table) resource paths (#631, PR #1616 review).
 *
 * `Resources.set` detects conflicts by comparing databaseName/tableName — both
 * `undefined` for two plain Resource classes, so a later registration at the same
 * path silently replaced the earlier one. For reserved fixed routes (the /v1
 * gateway), that let an app overwrite the endpoint — and its super_user gate —
 * with no startup error. `reservedPath = true` makes that a loud conflict.
 */

const assert = require('node:assert');
const { Resources } = require('#src/resources/Resources');
const { ErrorResource } = require('#src/resources/ErrorResource');

class ReservedThing {
	static reservedPath = true;
}
class PlainThing {}
class OtherPlainThing {}

describe('Resources reserved paths', () => {
	let resources;
	beforeEach(() => {
		resources = new Resources();
	});

	it('turns a later registration over a reserved path into a loud conflict (ErrorResource)', () => {
		resources.set('v1/models', ReservedThing);
		resources.set('v1/models', PlainThing);
		const entry = resources.get('v1/models');
		assert.ok(entry.Resource instanceof ErrorResource, 'conflict must be loud, not a silent replacement');
	});

	it('keeps same-class re-registration of a reserved path idempotent', () => {
		resources.set('v1/models', ReservedThing);
		resources.set('v1/models', ReservedThing);
		assert.equal(resources.get('v1/models').Resource, ReservedThing);
	});

	it('allows force to replace a reserved path (explicit override)', () => {
		resources.set('v1/models', ReservedThing);
		resources.set('v1/models', PlainThing, undefined, true);
		assert.equal(resources.get('v1/models').Resource, PlainThing);
	});

	it('preserves existing behavior: a plain non-table resource can still be replaced', () => {
		resources.set('widget', PlainThing);
		resources.set('widget', OtherPlainThing);
		assert.equal(resources.get('widget').Resource, OtherPlainThing, 'non-reserved replacement is unchanged');
	});

	it('preserves existing behavior: table identity mismatch still conflicts', () => {
		class TableA {
			static databaseName = 'data';
			static tableName = 'a';
		}
		class TableB {
			static databaseName = 'data';
			static tableName = 'b';
		}
		resources.set('t', TableA);
		resources.set('t', TableB);
		assert.ok(resources.get('t').Resource instanceof ErrorResource);
	});
});
