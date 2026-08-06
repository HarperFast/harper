const { setupTestDBPath } = require('../testUtils');
const assert = require('node:assert');
const { Store } = require('@harperfast/rocksdb-js');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { createBlob } = require('#src/resources/blob');

// Canary for PR #2103's claimed mechanism: "the VT populateVersion/expectedVersion read
// invalidates rocksdb-js's shared read buffer out from under the decode that consumes it."
//
// Hooks the two JS fill sites (Store.prototype.get / getSync return the module-level shared
// VALUE_BUFFER by identity whenever the native memcpy fast path was taken) and stamps a
// generation counter + captures the filler's stack. Store.prototype.decodeValue is wrapped to
// snapshot (generation, .end, leading bytes) before decode and compare after: any nested fill,
// .end change, or byte mutation mid-decode is recorded as an incident with the clobberer's
// stack. A self-check injects a synthetic nested read mid-decode to prove the harness catches
// exactly this class of bug before the clean runs assert zero incidents.

let generation = 0;
let sharedBuf = null; // identified by identity-repeat across fills
const seenBuffers = new WeakSet();
let lastFill = null; // { gen, stack }
let fillCount = 0;
let asyncSharedResolutions = 0;
const incidents = [];

function noteFill(res) {
	if (res === null || res === undefined || !Buffer.isBuffer(res)) return;
	if (sharedBuf === null) {
		if (seenBuffers.has(res)) sharedBuf = res;
		else seenBuffers.add(res);
	}
	if (res === sharedBuf) {
		generation++;
		fillCount++;
		lastFill = { gen: generation, stack: new Error('fill').stack };
	}
}

const origGetSync = Store.prototype.getSync;
Store.prototype.getSync = function (context, key, alwaysNew, options) {
	const res = origGetSync.call(this, context, key, alwaysNew, options);
	noteFill(res);
	return res;
};

const origGet = Store.prototype.get;
Store.prototype.get = function (context, key, alwaysNew, options) {
	const res = origGet.call(this, context, key, alwaysNew, options);
	if (res instanceof Promise) {
		// async path should ALWAYS resolve a fresh copy (napi_create_buffer_copy) — count violations
		res.then((v) => {
			if (v === sharedBuf && sharedBuf !== null) asyncSharedResolutions++;
		}, () => {});
	} else {
		noteFill(res);
	}
	return res;
};

const origDecodeValue = Store.prototype.decodeValue;
Store.prototype.decodeValue = function (value) {
	const isShared = sharedBuf !== null && value === sharedBuf;
	let genAtStart, endAtStart, snap;
	if (isShared) {
		genAtStart = generation;
		endAtStart = value.end;
		snap = Buffer.from(value.subarray(0, Math.min(endAtStart ?? value.length, 4096)));
	}
	try {
		return origDecodeValue.call(this, value);
	} finally {
		if (isShared) {
			const genChanged = generation !== genAtStart;
			const endChanged = value.end !== endAtStart;
			const bytesChanged = !snap.equals(value.subarray(0, snap.length));
			if (genChanged || endChanged || bytesChanged) {
				incidents.push({
					genChanged,
					endChanged,
					bytesChanged,
					genAtStart,
					genNow: generation,
					endAtStart,
					endNow: value.end,
					clobberStack: lastFill?.stack,
				});
			}
		}
	}
};

describe('VALUE_BUFFER canary: mid-decode clobber detection (PR #2103 mechanism)', () => {
	let T;
	before(async function () {
		this.timeout(20000);
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'CanaryBlobTable',
			database: 'packages',
			attributes: [
				{ name: 'path', isPrimaryKey: true },
				{ name: 'name', type: 'String', indexed: true },
				{ name: 'packageJson', type: 'Blob' },
			],
		});
		if (!T.primaryStore.encoder?.isRocksDB) this.skip();
		// prime: two sync reads of different warm keys → identity repeat identifies VALUE_BUFFER
		await T.put({ path: '/prime/1', name: 'p1', packageJson: '{"v":1}' });
		await T.put({ path: '/prime/2', name: 'p2', packageJson: '{"v":2}' });
		T.primaryStore.getSync('/prime/1');
		T.primaryStore.getSync('/prime/2');
		assert.ok(sharedBuf, 'canary failed to identify the shared VALUE_BUFFER — harness is not live');
	});

	it('self-check: an injected nested read mid-decode IS caught', async function () {
		this.timeout(20000);
		incidents.length = 0;
		// /prime/3: written but never read → not in the record cache, so the nested read
		// takes the real shared-buffer fill path instead of a VT FRESH hit
		await T.put({ path: '/prime/3', name: 'p3', packageJson: '{"v":3}' });
		// invalidate /prime/1's cache entry (putSync deletes it) so its read actually decodes
		await T.patch('/prime/1', { name: 'p1-invalidated' });
		const enc = T.primaryStore.encoder;
		const origDecode = enc.decode;
		let injected = false;
		enc.decode = function (buffer, options) {
			if (!injected && buffer === sharedBuf) {
				injected = true;
				// synthetic clobber: a nested shared-path read of another key mid-decode,
				// exactly the interleaving the PR's mechanism requires
				T.primaryStore.getSync('/prime/3');
			}
			return origDecode.call(this, buffer, options);
		};
		try {
			T.primaryStore.getSync('/prime/1');
		} finally {
			enc.decode = origDecode;
		}
		assert.ok(injected, 'injection never ran (decode not reached on shared buffer)');
		assert.ok(incidents.length > 0, 'harness FAILED to detect the injected mid-decode clobber');
		assert.ok(incidents.some((i) => i.genChanged), 'expected a generation change to be recorded');
		incidents.length = 0;
	});

	it('read-after-PATCH loop (PR repro ×200, growing payloads): zero mid-decode clobbers', async function () {
		this.timeout(60000);
		const id = '/node_modules/foo/package.json';
		await T.patch(id, { name: 'foo', packageJson: JSON.stringify({ version: '1.0.0' }) });
		for (let i = 1; i <= 200; i++) {
			// sizes sweep 1B..~8KB so in-record vs file-backed blob storage both get exercised
			const pad = 'x'.repeat((i * 41) % 8192);
			await T.patch(id, { packageJson: JSON.stringify({ version: `1.0.${i}`, pad }) });
			const record = await T.get(id);
			const text = await record.packageJson.text();
			assert.strictEqual(JSON.parse(text).version, `1.0.${i}`, `decode mismatch at cycle ${i}`);
			// warm sync re-read of the same record (shared-buffer path) as well
			const entry = T.primaryStore.getSync(id);
			assert.ok(entry, `sync re-read missing at cycle ${i}`);
		}
		assert.strictEqual(incidents.length, 0, `mid-decode clobbers detected:\n${JSON.stringify(incidents, null, 2)}`);
	});

	it('fresh createBlob round-trips + interleaved second-table reads: zero mid-decode clobbers', async function () {
		this.timeout(60000);
		const T2 = table({
			table: 'CanaryBlobTable2',
			database: 'packages',
			attributes: [
				{ name: 'path', isPrimaryKey: true },
				{ name: 'packageJson', type: 'Blob' },
			],
		});
		for (let i = 1; i <= 50; i++) {
			const id = `/blob/${i}`;
			await T.put({ path: id, name: `b${i}`, packageJson: createBlob(Buffer.from(`payload ${i} ` + 'y'.repeat(i * 100)), { type: 'text/plain' }) });
			await T2.put({ path: id, packageJson: JSON.stringify({ i }) });
			await T.patch(id, { packageJson: `patched over blob ${i}` });
			// interleave reads across the two cached (VT-enabled) tables
			const r1 = await T.get(id);
			const r2 = await T2.get(id);
			assert.strictEqual(await r1.packageJson.text(), `patched over blob ${i}`);
			assert.strictEqual(JSON.parse(await r2.packageJson.text()).i, i);
		}
		assert.strictEqual(incidents.length, 0, `mid-decode clobbers detected:\n${JSON.stringify(incidents, null, 2)}`);
	});

	after(() => {
		// eslint-disable-next-line no-console
		console.log(
			`\n[canary] shared-buffer fills: ${fillCount}, async resolutions that were the shared buffer (must be 0): ${asyncSharedResolutions}, incidents: ${incidents.length}`
		);
		for (const inc of incidents) {
			// eslint-disable-next-line no-console
			console.log('[canary incident]', JSON.stringify({ ...inc, clobberStack: undefined }), '\nclobberer stack:\n', inc.clobberStack);
		}
	});
});
