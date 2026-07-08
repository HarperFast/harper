const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const serverUtilities = require('#src/server/serverHelpers/serverUtilities');

// Verifies the fix for issue #1591: writes performed by operation handlers through the static
// Resource API without an explicit context must inherit user attribution from the operation
// request (via the ambient context established in processLocalTransaction).
describe('Operation ambient user context (audit attribution, issue #1591)', () => {
	let OpAuditTable;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		OpAuditTable = table({
			table: 'OpAuditTable',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
	});

	it('attributes a static put from an operation handler to the request user', async () => {
		await serverUtilities.processLocalTransaction(
			{ body: { operation: 'test_registered_op', hdb_user: { username: 'audit_user' } } },
			async () => {
				// simulates a registered operation handler using the static Resource API with no context
				await OpAuditTable.put('op-write', { name: 'from-op' });
				return { message: 'ok' };
			}
		);
		const history = await OpAuditTable.getHistoryOfRecord('op-write');
		assert.equal(history.length, 1);
		assert.equal(history[0].user, 'audit_user');
	});

	it('an explicit context passed by the handler still wins over the ambient user', async () => {
		await serverUtilities.processLocalTransaction(
			{ body: { operation: 'test_registered_op', hdb_user: { username: 'ambient_user' } } },
			async () => {
				await OpAuditTable.put('explicit-write', { name: 'explicit' }, { user: { username: 'explicit_user' } });
				return { message: 'ok' };
			}
		);
		const history = await OpAuditTable.getHistoryOfRecord('explicit-write');
		assert.equal(history.length, 1);
		assert.equal(history[0].user, 'explicit_user');
	});

	it('leaves writes unattributed when the request carries no hdb_user', async () => {
		await serverUtilities.processLocalTransaction({ body: { operation: 'test_registered_op' } }, async () => {
			await OpAuditTable.put('no-user-write', { name: 'no-user' });
			return { message: 'ok' };
		});
		const history = await OpAuditTable.getHistoryOfRecord('no-user-write');
		assert.equal(history.length, 1);
		assert.equal(history[0].user, undefined);
	});
});
