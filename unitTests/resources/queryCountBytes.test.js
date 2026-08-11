require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// Verifies that a `Prefer: count=` page — which is materialized and returned AFTER Table.search
// releases its read transaction — does not hand back Bytes fields that alias the (now-released) read
// buffer. If decoded Bytes are zero-copy views into the read snapshot, churning reads/writes after the
// count would mutate the already-returned page.
describe('Table.search count with Bytes columns (read-buffer safety)', () => {
	let BytesTable;
	const N = 5;
	const LEN = 64;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		BytesTable = table({
			table: 'BytesCountTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'data', type: 'Bytes' }],
		});
		let last;
		for (let i = 0; i < N; i++) {
			last = BytesTable.put({ id: i, data: new Uint8Array(LEN).fill(i + 1) });
		}
		await last;
	});

	it('exact count returns intact Bytes that survive post-release buffer churn', async function () {
		const page = await BytesTable.search({ limit: N, count: 'exact' });
		assert.strictEqual(page.recordCount, N);
		assert.strictEqual(page.length, N);

		// correctness immediately after the count released its read txn
		for (const rec of page) {
			assert.ok(rec.data && rec.data.length === LEN, `record ${rec.id} missing bytes`);
			assert.ok(
				[...rec.data].every((b) => b === rec.id + 1),
				`record ${rec.id} bytes wrong right after count: ${[...rec.data.slice(0, 4)]}`
			);
		}

		// Snapshot the returned bytes, then churn writes + reads to reuse read buffers.
		const snapshots = page.map((r) => [...r.data]);
		for (let r = 0; r < 60; r++) {
			await BytesTable.put({ id: 100 + r, data: new Uint8Array(LEN).fill(150 + (r % 100)) });
		}
		for (let round = 0; round < 5; round++) {
			// eslint-disable-next-line no-unused-vars
			for await (const _ of BytesTable.search({ limit: 500 })) {
			}
		}

		// The already-returned page must be unchanged — no aliasing of the released read buffer.
		page.forEach((rec, i) => {
			assert.deepStrictEqual(
				[...rec.data],
				snapshots[i],
				`record ${rec.id} bytes changed after churn — count page aliased the released read buffer`
			);
			assert.ok(
				[...rec.data].every((b) => b === rec.id + 1),
				`record ${rec.id} bytes corrupted after churn: ${[...rec.data.slice(0, 4)]}`
			);
		});
	});
});
