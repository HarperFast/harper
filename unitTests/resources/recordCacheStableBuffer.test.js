const { setupTestDBPath } = require('../testUtils');
const assert = require('node:assert');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// Reproduction for the Blob-column decode corruption ("Data read, but end of buffer not reached", or
// a record coming back with foreign bytes) reported against Harper 5.2.0.
//
// Mechanism: an inline Blob decoded from a cache/VT-enabled primary store keeps `storageBuffer` as a
// VIEW into the read buffer (not a copy). A read-modify-write — the shape of a REST PATCH — fetches
// the record, carries the unchanged Blob field, and re-puts it; the Blob re-encodes straight from
// `storageBuffer`. If any read in between reuses that buffer, the re-put serializes stale/foreign
// bytes. A pure-decode canary never sees this because the clobber is on the re-ENCODE.
describe('record cache: blob decode across put / read / read-other / re-put / read', () => {
	let T;
	before(async function () {
		this.timeout(20000);
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'BlobSeqRepro',
			database: 'packages',
			attributes: [
				{ name: 'path', isPrimaryKey: true },
				{ name: 'name', type: 'String', indexed: true },
				{ name: 'packageJson', type: 'Blob' },
			],
		});
	});

	async function readBlobText(id) {
		const record = await T.get(id);
		if (record == null) return null;
		return record.packageJson == null ? null : record.packageJson.text();
	}

	// Control: re-putting a brand-new Blob value (not the fetched one) round-trips fine, even with an
	// interleaved read of another key. This is the sequence our earlier tests exercised — it passes.
	it('re-put with a NEW blob value round-trips (control)', async function () {
		this.timeout(30000);
		const A = '/node_modules/ctl-a/package.json';
		const B = '/node_modules/ctl-b/package.json';
		await T.put({ path: B, name: 'b', packageJson: JSON.stringify({ pkg: 'B', pad: 'B'.repeat(64) }) });

		for (let i = 1; i <= 25; i++) {
			const aV1 = JSON.stringify({ pkg: 'A', v: i, pad: 'a'.repeat(i) });
			const aV2 = JSON.stringify({ pkg: 'A', v: i, pad: 'z'.repeat(i) });
			await T.put({ path: A, name: 'a', packageJson: aV1 });
			assert.strictEqual(await readBlobText(A), aV1, `read-after-put A @${i}`);
			await readBlobText(B); // read another key
			await T.put({ path: A, name: 'a', packageJson: aV2 }); // re-put a NEW value
			assert.strictEqual(await readBlobText(A), aV2, `final read A @${i}`);
		}
	});

	// Control: read-modify-write (carry the fetched Blob back into a re-put) with NO interleaved read.
	// If this fails too, re-encoding a fetched inline blob is broken unconditionally; if it passes,
	// the corruption specifically needs the buffer to be reused between fetch and re-put.
	it('read-modify-write with NO interleaved read (isolates buffer reuse)', async function () {
		this.timeout(30000);
		const A = '/node_modules/rmw0-a/package.json';

		let failures = 0;
		let firstErr;
		for (let i = 1; i <= 25; i++) {
			const aVal = JSON.stringify({ pkg: 'A', v: i, pad: 'a'.repeat(i) });
			try {
				await T.put({ path: A, name: 'a', packageJson: aVal });
				const recA = await T.get(A); // fetch (blob carries storageBuffer view)
				await T.put({ path: A, name: 'a-v2', packageJson: recA.packageJson }); // re-put fetched blob
				assert.strictEqual(await readBlobText(A), aVal, `@${i} got corrupted without interleave`);
			} catch (e) {
				failures++;
				if (!firstErr) firstErr = `@${i}: ${e.message}`;
			}
		}
		assert.strictEqual(failures, 0, `corruption without interleave on ${failures}/25 — first: ${firstErr}`);
	});

	// Regression guard (harper#2103): read-modify-write (PATCH shape) with an interleaved read that
	// reuses the buffer. Before the fix this corrupted A on 25/25 cycles (the re-put re-emitted the
	// blob's stale storageBuffer view); after the fix the re-put re-encodes from the copied
	// contentBuffer and A round-trips.
	it('read-modify-write WITH interleaved read does not corrupt the re-put', async function () {
		this.timeout(30000);
		const A = '/node_modules/rmw-a/package.json';
		const B = '/node_modules/rmw-b/package.json';

		let failures = 0;
		let firstErr;
		for (let i = 1; i <= 25; i++) {
			const aVal = JSON.stringify({ pkg: 'A', v: i, pad: 'a'.repeat(i) });
			const bVal = JSON.stringify({ pkg: 'B', v: i, pad: 'b'.repeat(200 + i) });
			try {
				await T.put({ path: B, name: 'b', packageJson: bVal });
				await T.put({ path: A, name: 'a', packageJson: aVal }); // put A
				const recA = await T.get(A); // read A — hold fetched record + its blob
				await readBlobText(B); // read another key — reuses the buffer backing A's storageBuffer
				await T.put({ path: A, name: 'a-v2', packageJson: recA.packageJson }); // re-put A carrying its blob
				const got = await readBlobText(A); // read A
				assert.strictEqual(got, aVal, `@${i} A blob corrupted after re-put: got ${String(got).slice(0, 80)}`);
			} catch (e) {
				failures++;
				if (!firstErr) firstErr = `@${i}: ${e.message}`;
			}
		}
		assert.strictEqual(failures, 0, `re-put corruption on ${failures}/25 cycles — first: ${firstErr}`);
	});
});
