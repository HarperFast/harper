const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { LOCAL_ONLY } = require('#src/resources/auditStore');
const { setTimeout: delay } = require('node:timers/promises');
require('#src/server/serverHelpers/serverUtilities');

// A table-reload marker is a whole-table signal (harper-pro#489): one LOCAL_ONLY audit entry of type
// 'reload' with no record, delivered to every subscriber on the table so they re-read it. It exists so
// copyApply (which back-fills base-copy rows as snapshots with no per-row audit entries) can cover the
// system DB, whose subscribers (hdb_nodes peer discovery, hdb_certificate CA install) drive off the
// audit `aftercommit` stream.
describe('table-reload marker (harper-pro#489)', () => {
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	async function waitFor(predicate, message, timeout = 5000) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			if (await predicate()) return;
			await delay(20);
		}
		throw new Error('waitFor timed out: ' + message);
	}

	it('delivers a reload event to every subscriber on the table', async function () {
		const ReloadTable = table({
			table: 'ReloadMarkerDeliver',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		// Two subscribers at different keys: the reload marker has no recordId, so BOTH must be notified.
		const rootEvents = [];
		const keyEvents = [];
		const rootSub = await ReloadTable.subscribe({});
		rootSub.on('data', (event) => rootEvents.push(event));
		const keySub = await ReloadTable.subscribe('some-key');
		keySub.on('data', (event) => keyEvents.push(event));

		await ReloadTable.writeReloadMarker();

		await waitFor(() => rootEvents.some((e) => e.type === 'reload'), 'root subscriber receives reload');
		await waitFor(() => keyEvents.some((e) => e.type === 'reload'), 'keyed subscriber receives reload');

		const reload = rootEvents.find((e) => e.type === 'reload');
		assert.equal(reload.value, undefined, 'reload carries no record value');
		assert.ok(reload.id == null, 'reload has no record id (whole-table signal)');
	});

	it('persists the marker as a local-only audit entry that never replicates', async function () {
		const ReloadTable = table({
			table: 'ReloadMarkerAudit',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		// touch the audit stream first so the table has an audit store wired up
		await ReloadTable.put({ id: 1, name: 'row' });
		await ReloadTable.writeReloadMarker();

		// The txn-log store's empty getRange positions at the tail (for live subscription), so scan from an
		// explicit numeric start to read the existing entries.
		let marker;
		for (const entry of ReloadTable.auditStore.getRange({ start: 1 })) {
			if (entry.type === 'reload') {
				marker = entry;
				break;
			}
		}
		assert.ok(marker, 'a reload audit entry was written');
		// LOCAL_ONLY makes the replication send path skip it by a bitmask test (no decode of an unknown
		// type on a peer): the marker is a local signal only.
		assert.ok(marker.extendedType & LOCAL_ONLY, 'reload marker is LOCAL_ONLY (never forwarded to peers)');
		assert.ok(marker.recordId == null, 'reload marker has a null recordId');
		// the regular row keeps its own audit entry; the marker did not disturb it
		assert.ok((await ReloadTable.getHistoryOfRecord(1)).length >= 1, 'the real row still has its audit entry');
	});
});
