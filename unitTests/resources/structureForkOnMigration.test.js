/**
 * Reproduces the v4→v5 migration "structure-id fork" that silently nulls records
 * (Akamai stage: HttpCache GETs returning null / "Data read, but end of buffer not
 * reached", ongoing). Root cause confirmed by byte-level trace of a live failing
 * record on nl-ams-1:
 *
 *   - DURABLE structures are canonical/correct: the record (a bare id-1 reference,
 *     encoded as [id, headers, content]) decodes perfectly against durable id1 =
 *     [id, headers, content].
 *   - The reading worker's IN-MEMORY dict is FORKED: it has a different structure
 *     (the nested headers-object) at id1, minted in a different order during the
 *     migration+ingest window. msgpackr only reloads on a *missing* id, never a
 *     present-but-wrong one, so a read-heavy worker never reloads and every read
 *     decodes against the stale fork -> field-count mismatch -> null.
 *
 * Writes self-correct via the saveStructures CAS, so durable stays canonical and the
 * data is recoverable: reloading structures on the decode error heals the read.
 */
require('../testUtils');
const assert = require('node:assert/strict');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

function makeTable() {
	return table({
		table: 'HttpCacheFork',
		database: 'cache',
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'headers' }, { name: 'content' }],
	});
}

describe('structure-id fork: stale worker in-memory dict vs canonical durable', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('a record decodes against canonical durable structures but fails against a forked in-memory dict; reload heals', async () => {
		const Tbl = makeTable();
		const enc = Tbl.primaryStore.encoder;

		// Establish the canonical durable structures + a stored record (nested headers object
		// + the [id, headers, content] record structure), exactly like the live data.
		await Tbl.put({
			id: 'k0',
			headers: { 'content-type': 'text/html', 'cache-control': 'max-age=3600' },
			content: Buffer.from('AAA'),
		});
		const canonical = enc.getStructures();
		const canonicalNamed = canonical instanceof Map ? canonical.get('named') : canonical;
		console.log('canonical durable named:', JSON.stringify(canonicalNamed));

		// Baseline: decodes correctly against canonical structures.
		const good = await Tbl.get('k0');
		assert.ok(good && good.headers && good.content, `baseline decode should work, got ${JSON.stringify(good)}`);

		// Simulate a forked worker: its in-memory dict minted the same structures in a DIFFERENT
		// order, so an id that durable maps to the record structure maps to a different structure
		// in memory. We reorder the in-memory array (durable/disk is untouched) and pin sharedLength
		// so the stale entries are treated as shared (the read path won't truncate+reload them).
		const forked = canonicalNamed.slice().reverse();
		forked.sharedLength = forked.length;
		enc.structures = forked;
		console.log('forked in-memory named:', JSON.stringify(enc.structures));

		// The read now decodes against the wrong structure-id mapping -> mismatch.
		let forkedResult,
			forkedThrew = false;
		try {
			forkedResult = enc.decode(Tbl.primaryStore.getBinary ? Tbl.primaryStore.getBinary('k0') : undefined);
		} catch (e) {
			forkedThrew = true;
			forkedResult = e.message;
		}
		const forkedBad =
			forkedThrew || !forkedResult || forkedResult.headers === undefined || forkedResult.content === undefined;
		console.log('forked decode:', forkedThrew ? 'THREW ' + forkedResult : JSON.stringify(forkedResult).slice(0, 120));
		assert.ok(forkedBad, 'a forked in-memory dict should mis-decode or fail the record (reproducing the live symptom)');

		// Recovery: reload the canonical durable structures -> in-memory realigns -> decode heals.
		enc._mergeStructures(enc.getStructures());
		const healed = await Tbl.get('k0');
		assert.ok(healed && healed.headers && healed.content, `reload should heal the read, got ${JSON.stringify(healed)}`);
		console.log('after reload, decode:', JSON.stringify(healed).slice(0, 120));
	});
});
