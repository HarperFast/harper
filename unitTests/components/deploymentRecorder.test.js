'use strict';

// Unit tests for the per-peer tracking and row-await helpers in DeploymentRecorder:
//   - `recordPeers()` — normalizes the opaque replication-layer per-peer outcomes into
//     a stable `[{node, status, error?, started_at, completed_at}]` shape on the row.
//   - `awaitDeploymentRow()` — peer-side helper that polls the hdb_deployment table
//     until the row arrives via replication, then returns it.
//
// These exercise the table layer via a tiny mock attached to `databases.system` —
// the recorder's `put()` already tolerates a missing table, so we only mock when we
// need to control the `.get()` return value or assert side effects.

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { DeploymentRecorder, awaitDeploymentRow } = require('#src/components/deploymentRecorder');
const { databases } = require('#src/resources/databases');
const terms = require('#src/utility/hdbTerms');

const DEPLOYMENT_TABLE = terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME;

// Lightweight mock: keeps a Map of rows, exposes get(id) and put(row).
function installMockDeploymentTable() {
	const rows = new Map();
	const mock = {
		rows,
		async get(id) {
			return rows.get(id);
		},
		async put(row) {
			rows.set(row.deployment_id, row);
		},
	};
	if (!databases.system) databases.system = {};
	const prior = databases.system[DEPLOYMENT_TABLE];
	databases.system[DEPLOYMENT_TABLE] = mock;
	return {
		mock,
		restore() {
			databases.system[DEPLOYMENT_TABLE] = prior;
		},
	};
}

describe('DeploymentRecorder.recordPeer', () => {
	let installed;
	beforeEach(() => {
		installed = installMockDeploymentTable();
	});
	afterEach(() => installed.restore());

	it('normalizes a single-peer success result', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ node: 'node-b', status: 'success', started_at: 1000, completed_at: 1500 });
		assert.deepStrictEqual(recorder.row.peer_results, [
			{ node: 'node-b', status: 'success', error: null, started_at: 1000, completed_at: 1500 },
		]);
	});

	it('maps an Error-bearing result to status="failed" with structured error', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ node: 'node-c', error: { message: 'install timed out', code: 'ETIMEDOUT' } });
		assert.deepStrictEqual(recorder.row.peer_results, [
			{
				node: 'node-c',
				status: 'failed',
				error: { message: 'install timed out', code: 'ETIMEDOUT' },
				started_at: null,
				completed_at: null,
			},
		]);
	});

	it('treats a string-shaped error as failed and preserves the message', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ node: 'node-d', error: 'connection refused' });
		assert.strictEqual(recorder.row.peer_results[0].status, 'failed');
		assert.strictEqual(recorder.row.peer_results[0].error.message, 'connection refused');
	});

	it('falls back to "name"/"hostname" when "node" is missing', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ name: 'node-by-name', status: 'success' });
		recorder.recordPeer({ hostname: 'node-by-hostname', status: 'success' });
		assert.strictEqual(recorder.row.peer_results[0].node, 'node-by-name');
		assert.strictEqual(recorder.row.peer_results[1].node, 'node-by-hostname');
	});

	it('preserves primitive entries as stringified raw markers', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer('node-x failed somehow');
		assert.strictEqual(recorder.row.peer_results[0].status, 'unknown');
		assert.strictEqual(recorder.row.peer_results[0].raw, 'node-x failed somehow');
	});

	it('upserts by node name on repeat calls — same peer transitions from pending to success', async () => {
		// The real-time use case: first call recorder.recordPeer({node:'n1', status:'pending'}),
		// then later recordPeer({node:'n1', status:'success'}). Only one entry should
		// exist for 'n1', and it should reflect the latest call.
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ node: 'n1', status: 'pending' });
		recorder.recordPeer({ node: 'n2', status: 'pending' });
		assert.strictEqual(recorder.row.peer_results.length, 2);
		recorder.recordPeer({ node: 'n1', status: 'success' });
		assert.strictEqual(recorder.row.peer_results.length, 2, 'no duplicate entry for n1');
		const n1 = recorder.row.peer_results.find((e) => e.node === 'n1');
		assert.strictEqual(n1.status, 'success', 'n1 upserted to latest status');
	});

	it('is a no-op when called after finish()', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		await recorder.finish('success');
		recorder.recordPeer({ node: 'node-late', status: 'success' });
		assert.deepStrictEqual(recorder.row.peer_results, []);
	});

	it('persists via scheduleFlush so the row eventually reflects peer outcomes', async () => {
		// recordPeer mutates in-memory and triggers the coalesced flush — by the time
		// finish() drains pending puts, the persisted row carries peer_results.
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ node: 'node-z', status: 'success' });
		await recorder.finish('success');
		const persisted = await installed.mock.get(recorder.deploymentId);
		assert.strictEqual(persisted.peer_results[0].node, 'node-z');
		assert.strictEqual(persisted.peer_results[0].status, 'success');
		assert.strictEqual(persisted.status, 'success');
	});
});

describe('DeploymentRecorder.recordPeers (bulk wrapper)', () => {
	let installed;
	beforeEach(() => {
		installed = installMockDeploymentTable();
	});
	afterEach(() => installed.restore());

	it('iterates the input array and upserts each entry', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeers([
			{ node: 'a', status: 'success' },
			{ node: 'b', status: 'success' },
		]);
		assert.strictEqual(recorder.row.peer_results.length, 2);
	});

	it('is idempotent when the same entries arrive via per-peer and aggregate paths', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ node: 'a', status: 'success' });
		recorder.recordPeers([{ node: 'a', status: 'success' }]);
		assert.strictEqual(recorder.row.peer_results.length, 1);
	});

	it('is a no-op for non-array inputs (defensive against odd replication shapes)', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeers(undefined);
		recorder.recordPeers(null);
		recorder.recordPeers('not an array');
		recorder.recordPeers({ node: 'object-not-array' });
		assert.deepStrictEqual(recorder.row.peer_results, []);
	});
});

describe('DeploymentRecorder.seal', () => {
	let installed;
	let putLog;
	beforeEach(() => {
		putLog = [];
		const rows = new Map();
		const mock = {
			rows,
			async get(id) {
				return rows.get(id);
			},
			async put(row) {
				putLog.push({ status: row.status, peerCount: (row.peer_results ?? []).length });
				rows.set(row.deployment_id, { ...row, peer_results: [...(row.peer_results ?? [])] });
			},
		};
		if (!databases.system) databases.system = {};
		const prior = databases.system[DEPLOYMENT_TABLE];
		databases.system[DEPLOYMENT_TABLE] = mock;
		installed = {
			mock,
			restore() {
				databases.system[DEPLOYMENT_TABLE] = prior;
			},
		};
	});
	afterEach(() => installed.restore());

	it('stops persisting intermediate updates once sealed, but finish() writes the terminal state', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		const putsAfterCreate = putLog.length;
		recorder.seal();
		recorder.recordPeer({ node: 'a', status: 'success' });
		recorder.recordPeer({ node: 'b', status: 'success' });
		assert.strictEqual(recorder.row.peer_results.length, 2, 'peer_results accumulate in memory while sealed');
		assert.strictEqual(putLog.length, putsAfterCreate, 'no puts are issued while sealed (pre-finish)');

		await recorder.finish('success');
		const terminal = putLog[putLog.length - 1];
		assert.strictEqual(terminal.status, 'success', 'finish() persists the terminal status');
		assert.strictEqual(terminal.peerCount, 2, 'finish() carries the accumulated peer_results');
		const persisted = await installed.mock.get(recorder.deploymentId);
		assert.strictEqual(persisted.status, 'success');
		assert.strictEqual(persisted.peer_results.length, 2);
	});

	it('does not affect persistence before seal: recordPeer still flushes incrementally', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		const putsAfterCreate = putLog.length;
		recorder.recordPeer({ node: 'a', status: 'success' });
		// scheduleFlush issues the put asynchronously; let it settle.
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(putLog.length > putsAfterCreate, 'an unsealed recordPeer persists incrementally');
	});
});

describe('awaitDeploymentRow', () => {
	let installed;
	beforeEach(() => {
		installed = installMockDeploymentTable();
	});
	afterEach(() => installed.restore());

	it('returns the row immediately when it is already present with payload_blob', async () => {
		const row = { deployment_id: 'd1', payload_blob: { fake: true } };
		installed.mock.rows.set('d1', row);
		const result = await awaitDeploymentRow('d1');
		assert.strictEqual(result, row);
	});

	it('skips a row with no payload_blob (still in flight) and resolves once it arrives', async () => {
		const id = 'd2';
		installed.mock.rows.set(id, { deployment_id: id, payload_blob: null });
		// Schedule a delayed write of the blob so the polling loop sees it.
		setTimeout(() => {
			installed.mock.rows.set(id, { deployment_id: id, payload_blob: { fake: true } });
		}, 50);
		const result = await awaitDeploymentRow(id, { timeoutMs: 1000, pollIntervalMs: 25 });
		assert.ok(result.payload_blob);
	});

	it('rejects with a timeout error when the row never arrives within timeoutMs', async () => {
		await assert.rejects(
			() => awaitDeploymentRow('never-arrives', { timeoutMs: 100, pollIntervalMs: 25 }),
			/Timed out after 100ms waiting for hdb_deployment row 'never-arrives'/
		);
	});

	it('throws if the deployment table is missing entirely (not yet provisioned)', async () => {
		delete databases.system[DEPLOYMENT_TABLE];
		await assert.rejects(() => awaitDeploymentRow('d3'), /Deployment tracking is not initialized on this node/);
	});
});
