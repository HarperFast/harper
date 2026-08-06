const { setupTestDBPath } = require('../testUtils');
const assert = require('node:assert');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { createBlob } = require('#src/resources/blob');

// Regression guard for the 5.2.0 Blob-column decode failure ("Data read, but end of buffer not
// reached"). The primary RocksDB store enables the record cache + VerificationTable; that
// version-tracking read invalidates rocksdb-js's shared VALUE_BUFFER before decode consumes it. Both
// storage engines only reuse that buffer when the decoder does NOT declare needsStableBuffer
// (decoderCopies = !decoder.needsStableBuffer). PrimaryRocksDatabase declares it on the encoder ONLY
// for cache-enabled stores, or a read-after-write on such a table decodes garbage; non-cached and
// LMDB stores keep the reused-buffer optimization. It regressed in 5.2.0 (the record cache/VT read
// path was added then); 5.1.x opened the primary store plainly and never hit it.
describe('record cache: stable read buffer (needsStableBuffer)', () => {
	let T;
	before(async function () {
		this.timeout(20000);
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'StableBufferRegr',
			database: 'packages',
			attributes: [
				{ name: 'path', isPrimaryKey: true },
				{ name: 'name', type: 'String', indexed: true },
				{ name: 'packageJson', type: 'Blob' },
			],
		});
	});

	it('the cache-enabled primary RocksDB store opts out of read-buffer reuse (decoderCopies === false)', function () {
		// The scoped fix: PrimaryRocksDatabase.initStore() flips decoderCopies=false for cache-enabled
		// stores only. Only meaningful for the RocksDB store (the default); the LMDB fallback's read
		// buffer is mmap-stable, so it never reuses in the unsafe way and has no decoderCopies to assert.
		if (!T.primaryStore.encoder.isRocksDB) return this.skip();
		assert.strictEqual(
			T.primaryStore.store.decoderCopies,
			false,
			'cache-enabled primary RocksDB store must not reuse its read buffer while the VT is active'
		);
	});

	it('read-after-PATCH on a Blob column decodes correctly with the cache on', async function () {
		this.timeout(20000);
		const id = '/node_modules/foo/package.json';
		// create, then repeatedly PATCH the existing record with a string->blob coercion (the reported
		// trigger) and read it straight back — each read exercises the cache/VT version read path.
		await T.patch(id, { name: 'foo', packageJson: JSON.stringify({ version: '1.0.0' }) });
		for (let i = 1; i <= 20; i++) {
			await T.patch(id, { packageJson: JSON.stringify({ version: `1.0.${i}`, pad: 'x'.repeat(i) }) });
			const record = await T.get(id);
			const text = await record.packageJson.text();
			assert.strictEqual(JSON.parse(text).version, `1.0.${i}`, `read-after-PATCH decode mismatch at cycle ${i}`);
		}
	});

	it('a fresh Blob value (createBlob) round-trips through the cached read path', async function () {
		this.timeout(20000);
		const id = '/node_modules/bar/package.json';
		await T.put({ path: id, name: 'bar', packageJson: createBlob(Buffer.from('hello world'), { type: 'text/plain' }) });
		await T.patch(id, { packageJson: 'patched value over the blob' });
		const record = await T.get(id);
		assert.strictEqual(await record.packageJson.text(), 'patched value over the blob');
	});
});
