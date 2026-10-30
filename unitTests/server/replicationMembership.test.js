require('../testUtils');
const assert = require('node:assert');
const { fenceMembershipChange } = require('#src/server/replicationMembership');

describe('fenceMembershipChange', function () {
	const operation = async () => 'done';

	for (const [label, routes] of [
		['REPLICATION_ROUTES', { REPLICATION_ROUTES: ['a'] }],
		['Replication_Routes', { Replication_Routes: ['a'] }],
		['replication_routes', { replication_routes: ['a'] }],
		['REPLICATION: { ROUTES }', { REPLICATION: { ROUTES: ['a'] } }],
		['replication: { routes }', { replication: { routes: ['a'] } }],
	]) {
		it(`wraps set_configuration naming ${label}`, function () {
			assert.notStrictEqual(fenceMembershipChange({ operation: 'set_configuration', ...routes }, operation), operation);
		});
	}

	it('returns the function unchanged for a set_configuration that leaves replication membership alone', function () {
		assert.strictEqual(
			fenceMembershipChange({ operation: 'set_configuration', logging_level: 'info' }, operation),
			operation
		);
		assert.strictEqual(
			fenceMembershipChange({ operation: 'set_configuration', REPLICATION: { PORT: 9925 } }, operation),
			operation
		);
	});
});
