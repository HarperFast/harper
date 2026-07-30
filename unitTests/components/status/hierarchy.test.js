'use strict';

const assert = require('node:assert');
const { buildHierarchy } = require('#src/components/status/hierarchy');
const { COMPONENT_STATUS_LEVELS } = require('#src/components/status/types');

function agg(status, extra = {}) {
	return { componentName: 'unused', status, lastChecked: { workers: {} }, ...extra };
}

describe('buildHierarchy', function () {
	it('builds a single-level leaf node for a name with no dots', function () {
		const statuses = new Map([['replication', agg(COMPONENT_STATUS_LEVELS.ERROR, { latestMessage: 'down' })]]);

		const tree = buildHierarchy(statuses);

		assert.equal(tree.replication.status, COMPONENT_STATUS_LEVELS.ERROR);
		assert.equal(tree.replication.message, 'down');
		assert.equal(tree.replication.children, undefined);
	});

	it('splits a dotted name into parent/child nodes', function () {
		const statuses = new Map([['system.disk', agg(COMPONENT_STATUS_LEVELS.WARNING, { latestMessage: '85% full' })]]);

		const tree = buildHierarchy(statuses);

		assert.ok(tree.system, 'parent node should exist');
		assert.ok(tree.system.children, 'parent should have children');
		assert.equal(tree.system.children.disk.status, COMPONENT_STATUS_LEVELS.WARNING);
		assert.equal(tree.system.children.disk.message, '85% full');
	});

	it('rolls up the worst child status to the parent (error beats warning/healthy)', function () {
		const statuses = new Map([
			['system.disk', agg(COMPONENT_STATUS_LEVELS.HEALTHY)],
			['system.memory', agg(COMPONENT_STATUS_LEVELS.WARNING)],
			['system.cpu', agg(COMPONENT_STATUS_LEVELS.ERROR)],
		]);

		const tree = buildHierarchy(statuses);

		assert.equal(tree.system.status, COMPONENT_STATUS_LEVELS.ERROR, 'parent should roll up to the worst child');
	});

	it('rolls up through multiple levels of nesting', function () {
		const statuses = new Map([
			['application.rest.orders', agg(COMPONENT_STATUS_LEVELS.HEALTHY)],
			['application.rest.users', agg(COMPONENT_STATUS_LEVELS.ERROR)],
		]);

		const tree = buildHierarchy(statuses);

		assert.equal(tree.application.status, COMPONENT_STATUS_LEVELS.ERROR);
		assert.equal(tree.application.children.rest.status, COMPONENT_STATUS_LEVELS.ERROR);
		assert.equal(tree.application.children.rest.children.orders.status, COMPONENT_STATUS_LEVELS.HEALTHY);
		assert.equal(tree.application.children.rest.children.users.status, COMPONENT_STATUS_LEVELS.ERROR);
	});

	it('defaults an intermediate node with no own status entry to healthy before roll-up', function () {
		// 'system' itself never appears as a key -- only 'system.disk' does.
		const statuses = new Map([['system.disk', agg(COMPONENT_STATUS_LEVELS.HEALTHY)]]);

		const tree = buildHierarchy(statuses);

		assert.equal(tree.system.status, COMPONENT_STATUS_LEVELS.HEALTHY);
	});

	it('returns an empty tree for an empty status map', function () {
		const tree = buildHierarchy(new Map());
		assert.deepStrictEqual(tree, {});
	});

	it('carries occurrenceCount and error through to the leaf node', function () {
		const error = new Error('boom');
		const statuses = new Map([
			['database.write-queue-overloaded', agg(COMPONENT_STATUS_LEVELS.ERROR, { occurrenceCount: 3, error })],
		]);

		const tree = buildHierarchy(statuses);

		assert.equal(tree.database.children['write-queue-overloaded'].occurrenceCount, 3);
		assert.equal(tree.database.children['write-queue-overloaded'].error, error);
	});
});
