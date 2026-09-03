require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const {
	getFilePathForBlob,
	saveBlob,
	decodeFromDatabase,
	isBlobComplete,
	resolveBlobCompression,
	createBlobFromStoredBody,
	openStoredBlobBody,
	getFileId,
	inflatesToExactly,
} = require('#src/resources/blob');
const { Readable } = require('node:stream');
const { syncBuiltinESMExports } = require('node:module');
const zlib = require('node:zlib');
const { deflateSync } = zlib;
const fs = require('node:fs');
const { readFileSync, statSync, openSync, writeSync, closeSync, truncateSync, renameSync, writeFileSync, rmSync } = fs;
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

const HEADER_SIZE = 8;
const UNCOMPRESSED_TYPE = 0;
const DEFLATE_TYPE = 1;

function headerTypeOf(blob) {
	return readFileSync(getFilePathForBlob(blob))[1];
}

async function streamToBuffer(stream, onChunk) {
	const reader = stream.getReader();
	const chunks = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		onChunk?.(value);
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

function setCompressionConfig(value) {
	env.setProperty(CONFIG_PARAMS.STORAGE_BLOBS_COMPRESSION, value);
}

describe('Blob compression (harper#2443)', () => {
	let CompressionTest;
	let store;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		CompressionTest = table({
			table: 'CompressionTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'blob', type: 'Blob' },
			],
		});
		store = CompressionTest.primaryStore.rootStore;
	});
	afterEach(() => {
		setCompressionConfig(undefined);
	});

	async function putBlob(id, source, options) {
		const blob = createBlob(source, options);
		await CompressionTest.put({ id, blob });
		await blob.written;
		return blob;
	}

	it('streams a large compressed blob with bounded chunks, never buffering via bytes()', async function () {
		this.timeout(30000);
		const payload = Buffer.alloc(48 * 1024 * 1024, 'harper blob compression test payload ');
		const blob = await putBlob(100, payload, { compress: true, type: 'text/plain' });
		assert.equal(headerTypeOf(blob), DEFLATE_TYPE);
		const record = await CompressionTest.get(100);
		record.blob.bytes = () => {
			throw new Error('stream() of a compressed blob must not buffer the whole content via bytes()');
		};
		let maxChunk = 0;
		let position = 0;
		const streamed = await streamToBuffer(record.blob.stream(), (chunk) => {
			maxChunk = Math.max(maxChunk, chunk.length);
			assert(payload.subarray(position, position + chunk.length).equals(chunk), `chunk at ${position} must match`);
			position += chunk.length;
		});
		assert.equal(streamed.length, payload.length);
		assert(
			maxChunk <= 4 * 1024 * 1024,
			`chunks must stay bounded (saw a ${maxChunk}-byte chunk for a ${payload.length}-byte blob)`
		);
	});

	it('round-trips byte-identically through bytes(), stream(), and a ranged slice under each config shape', async () => {
		const shapes = [
			{ config: { default: { codec: 'deflate' } }, type: 'application/octet-stream', headerType: DEFLATE_TYPE },
			{ config: { 'text/*': { codec: 'deflate', threshold: 8192 } }, type: 'text/plain', headerType: DEFLATE_TYPE },
			{ config: { 'application/json': { codec: 'deflate' } }, type: 'application/json', headerType: DEFLATE_TYPE },
			{ config: undefined, type: 'text/plain', headerType: UNCOMPRESSED_TYPE }, // absent config = off
		];
		let id = 110;
		for (const shape of shapes) {
			setCompressionConfig(shape.config);
			const payload = Buffer.from(`config shape ${JSON.stringify(shape.config)} payload `.repeat(3000));
			const blob = await putBlob(id, payload, { type: shape.type });
			assert.equal(headerTypeOf(blob), shape.headerType, `header type under ${JSON.stringify(shape.config)}`);
			const record = await CompressionTest.get(id);
			assert(Buffer.from(await record.blob.bytes()).equals(payload), 'bytes() round-trip');
			assert((await streamToBuffer(record.blob.stream())).equals(payload), 'stream() round-trip');
			const ranged = await streamToBuffer(record.blob.slice(1000, 50000).stream());
			assert(ranged.equals(payload.subarray(1000, 50000)), 'ranged stream() round-trip');
			assert(Buffer.from(await record.blob.slice(1000, 50000).bytes()).equals(payload.subarray(1000, 50000)));
			id++;
		}
	});

	it('leaves already-compressed types uncompressed under the shipped defaults', async () => {
		setCompressionConfig({ default: { codec: 'deflate' } });
		const payload = Buffer.from('already compressed container payload '.repeat(1000));
		const gzipBlob = await putBlob(120, payload, { type: 'application/gzip' });
		assert.equal(headerTypeOf(gzipBlob), UNCOMPRESSED_TYPE, 'application/gzip must not be compressed');
		const imageBlob = await putBlob(121, payload, { type: 'image/png' });
		assert.equal(headerTypeOf(imageBlob), UNCOMPRESSED_TYPE, 'image/* must not be compressed');
		const videoBlob = await putBlob(122, payload, { type: 'video/mp4' });
		assert.equal(headerTypeOf(videoBlob), UNCOMPRESSED_TYPE, 'video/* must not be compressed');
		const textBlob = await putBlob(123, payload, { type: 'text/plain' });
		assert.equal(headerTypeOf(textBlob), DEFLATE_TYPE, 'an ordinary type compresses under default');
		assert((await streamToBuffer(textBlob.stream())).equals(payload));
	});

	it('threshold gates by known size; unknown-size streamed writes stay uncompressed', async () => {
		setCompressionConfig({ default: { codec: 'deflate', threshold: 100000 } });
		const below = await putBlob(130, Buffer.alloc(50000, 'x'), { type: 'text/plain' });
		assert.equal(headerTypeOf(below), UNCOMPRESSED_TYPE, 'below threshold stays uncompressed');
		const above = await putBlob(131, Buffer.alloc(200000, 'x'), { type: 'text/plain' });
		assert.equal(headerTypeOf(above), DEFLATE_TYPE, 'at/above threshold compresses');
		const unknownSize = await putBlob(132, Readable.from([Buffer.alloc(200000, 'x')]), { type: 'text/plain' });
		assert.equal(headerTypeOf(unknownSize), UNCOMPRESSED_TYPE, 'unknown-size streams stay uncompressed');
		// a streamed source WITH a declared size is measurable
		const sizedStream = await putBlob(133, Readable.from([Buffer.alloc(200000, 'x')]), {
			type: 'text/plain',
			size: 200000,
		});
		assert.equal(headerTypeOf(sizedStream), DEFLATE_TYPE, 'declared-size streams compress');
	});

	it('resolveBlobCompression: precedence is exact type, then type/*, then default; operator overrides built-ins per key', () => {
		const size = 1 << 20;
		setCompressionConfig({ default: { codec: 'deflate' } });
		assert.equal(resolveBlobCompression('text/plain', size), true);
		assert.equal(resolveBlobCompression('application/gzip', size), false, 'shipped exact false');
		assert.equal(resolveBlobCompression('image/svg+xml', size), false, 'shipped image/* false');
		assert.equal(resolveBlobCompression('', size), true, 'untyped blobs match default');
		assert.equal(resolveBlobCompression('text/plain; charset=utf-8', size), true, 'parameters are stripped');
		assert.equal(resolveBlobCompression('TEXT/PLAIN', size), true, 'matching is case-insensitive');

		// operator wildcard does NOT override a shipped exact entry: specificity beats origin
		setCompressionConfig({ 'default': { codec: 'deflate' }, 'application/*': { codec: 'deflate' } });
		assert.equal(resolveBlobCompression('application/gzip', size), false);
		assert.equal(resolveBlobCompression('application/json', size), true);

		// operator entry for the same key overrides the shipped one
		setCompressionConfig({ 'image/*': { codec: 'deflate' } });
		assert.equal(resolveBlobCompression('image/png', size), true);
		// exact beats wildcard within the operator's own map, and false opts out
		setCompressionConfig({ 'default': { codec: 'deflate' }, 'text/*': false, 'text/csv': { codec: 'deflate' } });
		assert.equal(resolveBlobCompression('text/plain', size), false);
		assert.equal(resolveBlobCompression('text/csv', size), true);

		setCompressionConfig(undefined);
		assert.equal(resolveBlobCompression('text/plain', size), false, 'absent config compresses nothing');
	});

	it('createBlobFromStoredBody stores a peer-compressed body verbatim, and verifies it on write', async () => {
		const payload = Buffer.from('replicated compressed payload '.repeat(4000));
		const compressed = deflateSync(payload);

		const blob = createBlobFromStoredBody(Readable.from([compressed]), {
			type: 'text/plain',
			size: payload.length,
			codec: 'deflate',
		});
		await CompressionTest.put({ id: 140, blob });
		await blob.written;
		const stored = readFileSync(getFilePathForBlob(blob));
		assert.equal(stored[1], DEFLATE_TYPE);
		assert(stored.subarray(HEADER_SIZE).equals(compressed), 'the body must be the peer bytes, verbatim');
		assert.equal(await isBlobComplete(blob), true);
		const record = await CompressionTest.get(140);
		assert(Buffer.from(await record.blob.bytes()).equals(payload));
		assert((await streamToBuffer(record.blob.stream())).equals(payload));

		// a truncated body must reject the save, not publish a torn file under a finalized header
		const torn = createBlobFromStoredBody(Readable.from([compressed.subarray(0, compressed.length - 10)]), {
			size: payload.length,
			codec: 'deflate',
		});
		await assert.rejects(
			decodeFromDatabase(() => saveBlob(torn).saving, store),
			/not a valid deflate stream|inflated to/
		);

		// a body that inflates to the wrong length must reject
		const wrongSize = createBlobFromStoredBody(Readable.from([compressed]), {
			size: payload.length + 1,
			codec: 'deflate',
		});
		await assert.rejects(
			decodeFromDatabase(() => saveBlob(wrongSize).saving, store),
			/inflated to/
		);

		// trailing bytes after the deflate stream: detection is best-effort (zlib's write callback can
		// race its early 'end'), so the binding contract is no corruption — if the save is accepted,
		// every reader still returns exactly the declared content and the blob classifies complete
		const trailing = createBlobFromStoredBody(Readable.from([compressed, Buffer.from('trailing garbage')]), {
			type: 'text/plain',
			size: payload.length,
			codec: 'deflate',
		});
		const trailingOutcome = await decodeFromDatabase(() => saveBlob(trailing).saving, store).then(
			() => 'saved',
			(error) => {
				assert.match(error.message, /past the end of its deflate stream/);
				return 'rejected';
			}
		);
		if (trailingOutcome === 'saved') {
			assert(Buffer.from(await trailing.bytes()).equals(payload));
			assert((await streamToBuffer(trailing.stream())).equals(payload));
			assert.equal(await isBlobComplete(trailing), true);
		}

		// an unknown uncompressed size cannot stamp a truthful header
		const sizeless = createBlobFromStoredBody(Readable.from([compressed]), { size: undefined, codec: 'deflate' });
		await assert.rejects(
			decodeFromDatabase(() => saveBlob(sizeless).saving, store),
			/known uncompressed size/
		);

		// an empty blob is still a well-formed (empty) deflate stream
		const empty = createBlobFromStoredBody(Readable.from([deflateSync(Buffer.alloc(0))]), {
			size: 0,
			codec: 'deflate',
		});
		await decodeFromDatabase(() => saveBlob(empty).saving, store);
		assert.equal(readFileSync(getFilePathForBlob(empty))[1], DEFLATE_TYPE);
		assert.deepEqual(await empty.bytes(), Buffer.alloc(0));
		assert.deepEqual(await streamToBuffer(empty.stream()), Buffer.alloc(0));

		// none of these saves was put into a record: remove their files so the orphan-sweep test in
		// blob.test.js (which asserts zero orphans) stays independent of file ordering
		for (const unreferenced of [torn, wrongSize, trailing, sizeless, empty]) {
			rmSync(getFilePathForBlob(unreferenced), { force: true });
		}
	});

	it('bounds the output of a compressed blob whose header understates its size', async () => {
		const payload = Buffer.from('bounded output payload '.repeat(8000));
		const blob = await putBlob(150, payload, { compress: true, type: 'text/plain' });
		const filePath = getFilePathForBlob(blob);
		// rewrite the header to declare a much smaller (but finalized) uncompressed size
		const lyingSize = 1000;
		const header = Buffer.alloc(HEADER_SIZE);
		new DataView(header.buffer).setBigInt64(0, BigInt(lyingSize) | (BigInt(DEFLATE_TYPE) << 48n));
		const fd = openSync(filePath, 'r+');
		writeSync(fd, header, 0, HEADER_SIZE, 0);
		closeSync(fd);

		// a full read cross-checks the record descriptor against the header (#1424)
		const record = await CompressionTest.get(150);
		await assert.rejects(streamToBuffer(record.blob.stream()), /size mismatch/);

		// a ranged read has no descriptor to cross-check, so the inflate itself must stop at the
		// declared size instead of streaming the (larger) real content
		let emitted = 0;
		await assert.rejects(
			streamToBuffer(record.blob.slice(0, 5000).stream(), (chunk) => (emitted += chunk.length)),
			/inflates past its declared size/
		);
		assert(emitted <= lyingSize, `must not emit past the declared size (emitted ${emitted})`);

		await assert.rejects(record.blob.slice(0, 5000).bytes(), /inflates past its declared size/);
	});

	it('clamps a ranged read past the end of a compressed blob like an uncompressed one', async () => {
		const payload = Buffer.from('over-range slice payload '.repeat(4000));
		const compressed = await putBlob(151, payload, { compress: true, type: 'text/plain' });
		const plain = await putBlob(152, payload, { compress: false, type: 'text/plain' });
		assert.equal(headerTypeOf(compressed), DEFLATE_TYPE);
		assert.equal(headerTypeOf(plain), UNCOMPRESSED_TYPE);
		const tail = payload.subarray(payload.length - 100);
		for (const id of [151, 152]) {
			const { blob } = await CompressionTest.get(id);
			const slice = blob.slice(payload.length - 100, payload.length + 5000);
			assert(Buffer.from(await slice.bytes()).equals(tail), `bytes() of over-range slice (${id})`);
			assert((await streamToBuffer(slice.stream())).equals(tail), `stream() of over-range slice (${id})`);
		}
	});

	it('inflatesToExactly stops a body that inflates past the expected size instead of draining it', async () => {
		const bombSize = 64 * 1024 * 1024;
		const blob = await putBlob(153, Buffer.alloc(bombSize), { compress: true, type: 'text/plain' });
		const filePath = getFilePathForBlob(blob);
		assert(statSync(filePath).size < 256 * 1024, 'precondition: a tiny body inflating to 64 MiB');
		let peakInflated = 0;
		// zlib's exports are non-writable (a plain assignment is silently ignored), so redefine; then
		// syncBuiltinESMExports() so blob.ts's `import { createInflate } from 'node:zlib'` picks up the
		// patched value — under --conditions=typestrip it loads as ESM with link-time bindings the CJS
		// namespace mutation would otherwise never reach, leaving peakInflated at 0.
		const originalInflate = Object.getOwnPropertyDescriptor(zlib, 'createInflate');
		Object.defineProperty(zlib, 'createInflate', {
			...originalInflate,
			value: (...args) => {
				const inflater = originalInflate.value.apply(zlib, args);
				inflater.on('data', (chunk) => (peakInflated += chunk.length));
				return inflater;
			},
		});
		syncBuiltinESMExports();
		try {
			assert.equal(await inflatesToExactly(filePath, 1000), false);
			assert.equal(await inflatesToExactly(filePath, bombSize), true);
		} finally {
			Object.defineProperty(zlib, 'createInflate', originalInflate);
			syncBuiltinESMExports();
		}
		assert(peakInflated >= bombSize, `the exact expectation must inflate the whole body (saw ${peakInflated})`);
		assert(
			peakInflated < bombSize + 4 * 1024 * 1024,
			`the short expectation must abandon the inflate early (saw ${peakInflated})`
		);
	});

	it('stamps the storage codec into the stored blob reference as a local hint', async () => {
		setCompressionConfig({ default: { codec: 'deflate' } });
		const compressedBlob = await putBlob(155, Buffer.from('hinted payload '.repeat(2000)), { type: 'text/plain' });
		assert.equal(headerTypeOf(compressedBlob), DEFLATE_TYPE);
		assert.equal((await CompressionTest.get(155)).blob.storedCodec, 'deflate', 'compressed refs must carry the hint');
		setCompressionConfig(undefined);
		await putBlob(156, Buffer.from('unhinted payload '.repeat(2000)), { type: 'text/plain' });
		assert.equal((await CompressionTest.get(156)).blob.storedCodec, undefined, 'uncompressed refs must carry none');
	});

	it('the hint does not touch a blob property named codec', async () => {
		setCompressionConfig({ default: { codec: 'deflate' } });
		const blob = await createBlob(Buffer.from('media payload '.repeat(2000)), { type: 'text/plain' });
		blob.codec = 'h264';
		await CompressionTest.put({ id: 157, blob });
		await blob.written;
		assert.equal(headerTypeOf(blob), DEFLATE_TYPE);
		const stored = (await CompressionTest.get(157)).blob;
		assert.equal(stored.codec, 'h264', 'a user codec property must survive compression');
		assert.equal(stored.storedCodec, 'deflate');
	});

	it('a compressed stream() reads through the descriptor it opened, without reopening the file', async () => {
		const payload = Buffer.alloc(3 * 1024 * 1024, 'single open ');
		await putBlob(158, payload, { compress: true, type: 'text/plain' });
		const record = await CompressionTest.get(158);
		const opens = [];
		const originalOpen = fs.open;
		fs.open = function (path, ...rest) {
			opens.push(path);
			return originalOpen.call(fs, path, ...rest);
		};
		const originalCreateReadStream = fs.createReadStream;
		let streamOpenedByPath = false;
		fs.createReadStream = function (path, options) {
			if (options?.fd === undefined) streamOpenedByPath = true;
			return originalCreateReadStream.call(fs, path, options);
		};
		// propagate the fs patches to blob.ts's ESM `import { open, createReadStream } from 'node:fs'`
		// bindings, which under --conditions=typestrip are link-time and ignore the CJS namespace mutation.
		syncBuiltinESMExports();
		try {
			assert((await streamToBuffer(record.blob.stream())).equals(payload));
		} finally {
			fs.open = originalOpen;
			fs.createReadStream = originalCreateReadStream;
			syncBuiltinESMExports();
		}
		assert.equal(opens.length, 1, `the read must open the file exactly once (saw ${opens.length})`);
		assert.equal(streamOpenedByPath, false, 'the inflate source must reuse the descriptor of the first read');
	});

	it('a compressed read waits for the writer and times out with a retryable 503', async function () {
		this.timeout(10000);
		const payload = Buffer.from('waits for the writer '.repeat(2000));
		const blob = await putBlob(160, payload, { compress: true, type: 'text/plain' });
		const lockKey = getFileId(blob) + ':blob';
		const record = await CompressionTest.get(160);

		// writer appears busy: the read waits, then completes once the lock releases
		assert.ok(store.tryLock(lockKey));
		let settled = false;
		const pendingRead = streamToBuffer(record.blob.stream()).finally(() => (settled = true));
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(settled, false, 'the read must wait while a writer appears to hold the file');
		store.unlock(lockKey);
		assert((await pendingRead).equals(payload));

		// a writer that never finishes turns into a prompt, retryable 503 (#1423)
		env.setProperty(CONFIG_PARAMS.STORAGE_BLOBREADTIMEOUT, '150');
		try {
			assert.ok(store.tryLock(lockKey));
			await assert.rejects(streamToBuffer((await CompressionTest.get(160)).blob.stream()), (error) => {
				assert.equal(error.statusCode, 503);
				return true;
			});
		} finally {
			store.unlock(lockKey);
			env.setProperty(CONFIG_PARAMS.STORAGE_BLOBREADTIMEOUT, undefined);
		}
	});

	it('cancelling a compressed stream mid-read tears down cleanly', async () => {
		const payload = Buffer.alloc(4 * 1024 * 1024, 'cancel me ');
		await putBlob(170, payload, { compress: true, type: 'text/plain' });
		const record = await CompressionTest.get(170);
		const reader = record.blob.stream().getReader();
		const { value } = await reader.read();
		assert(value.length > 0);
		await reader.cancel();
		// the backing machinery must be torn down without an uncaught error; a follow-up read works
		assert((await streamToBuffer(record.blob.stream())).equals(payload));
	});

	it('openStoredBlobBody exposes the raw deflate body of a settled compressed blob, and only that', async () => {
		const payload = Buffer.from('raw send body '.repeat(5000));
		const blob = await putBlob(180, payload, { compress: true, type: 'text/plain' });
		const filePath = getFilePathForBlob(blob);
		const onDiskBody = readFileSync(filePath).subarray(HEADER_SIZE);

		const stored = openStoredBlobBody(blob);
		assert(stored, 'a settled compressed blob must open');
		assert.equal(stored.codec, 'deflate');
		assert.equal(stored.size, payload.length);
		const chunks = [];
		for await (const chunk of stored.stream()) chunks.push(chunk);
		assert(Buffer.concat(chunks).equals(onDiskBody), 'must stream the raw post-header bytes');

		// an uncompressed blob has no stored deflate body
		const uncompressed = await putBlob(181, payload, { type: 'text/plain' });
		assert.equal(openStoredBlobBody(uncompressed), undefined);

		assert.equal(openStoredBlobBody(blob.slice(100, 200)), undefined, 'a slice has no raw body');

		// a writer holding the lock means the body may still be streaming: decline
		const lockKey = getFileId(blob) + ':blob';
		assert.ok(store.tryLock(lockKey));
		try {
			assert.equal(openStoredBlobBody(blob), undefined);
		} finally {
			store.unlock(lockKey);
		}

		// closing without streaming releases the reader; a later stream() is refused
		const closed = openStoredBlobBody(blob);
		closed.close();
		await assert.rejects(closed.stream().next(), /already consumed or closed/);

		// the file replaced between the decision and the stream (an in-place repair publishing an
		// uncompressed result over the path) is refused as transient, not streamed as a torn deflate body
		const opened = openStoredBlobBody(blob);
		const original = readFileSync(filePath);
		const repaired = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), payload]);
		repaired.writeUIntBE(payload.length, 2, 6);
		writeFileSync(filePath + '.replacement', repaired);
		renameSync(filePath + '.replacement', filePath);
		try {
			await assert.rejects(opened.stream().next(), (error) => {
				assert.equal(error.statusCode, 503, 'a replaced stored body must be retryable (503)');
				assert.match(error.message, /replaced before it was streamed/);
				return true;
			});
		} finally {
			writeFileSync(filePath, original);
		}
		assert((await streamToBuffer((await CompressionTest.get(180)).blob.stream())).equals(payload));

		// a torn body passes the header sniff but must fail verification before the stream ends cleanly
		truncateSync(filePath, statSync(filePath).size - 10);
		const tornStored = openStoredBlobBody(blob);
		assert(tornStored, 'the sniff cannot see a torn body — verification is what catches it');
		await assert.rejects(
			(async () => {
				for await (const _chunk of tornStored.stream()) {
					// drain
				}
			})(),
			(error) => {
				assert.equal(error.statusCode, 500, 'a torn stored body is a permanent (500) failure');
				return true;
			}
		);
	});

	it('a stored-body write round-trips through openStoredBlobBody (receiver becomes a faithful relay)', async () => {
		const payload = Buffer.from('relay chain payload '.repeat(4000));
		const compressed = deflateSync(payload);
		const blob = createBlobFromStoredBody(Readable.from([compressed]), {
			type: 'text/plain',
			size: payload.length,
			codec: 'deflate',
		});
		await CompressionTest.put({ id: 190, blob });
		await blob.written;
		const stored = openStoredBlobBody(blob);
		assert(stored);
		const chunks = [];
		for await (const chunk of stored.stream()) chunks.push(chunk);
		assert(Buffer.concat(chunks).equals(compressed), 'a relayed body must be byte-identical to the origin bytes');
	});

	it('classifies a torn compressed body incomplete, and its read fails loudly as corrupt', async () => {
		const payload = Buffer.alloc(30000, 'classify me ');
		const blob = await putBlob(200, payload, { compress: true, type: 'text/plain' });
		assert.equal(await isBlobComplete(blob), true);
		const filePath = getFilePathForBlob(blob);
		truncateSync(filePath, statSync(filePath).size - 15);
		assert.equal(await isBlobComplete(blob), false, 'a torn compressed body must classify incomplete');
		// and the streaming read of that torn body fails loudly as corrupt, not silently short
		await assert.rejects(streamToBuffer((await CompressionTest.get(200)).blob.stream()), (error) => {
			assert.equal(error.statusCode, 500);
			return true;
		});
	});

	// A deflate body corrupted mid-stream (as opposed to truncated) makes zlib raise Z_DATA_ERROR while
	// consuming a chunk, which drops the pending inflater.write callback. A verifier that waited only on
	// that callback would hang forever; these two tests fail by timeout without the error/close settle.
	it('rejects a corrupt stored body on receive instead of hanging the write pipeline', async function () {
		this.timeout(5000);
		// An invalid zlib stream: inflate raises Z_DATA_ERROR while consuming a chunk (not a clean end or
		// an oversize, both of which zlib settles on its own), which is the case that drops the write
		// callback — a verifier that waited only on that callback would hang the whole write pipeline.
		const corrupt = Buffer.alloc(512 * 1024, 0xff);
		const chunks = [];
		for (let o = 0; o < corrupt.length; o += 65536) chunks.push(corrupt.subarray(o, o + 65536));
		const blob = createBlobFromStoredBody(Readable.from(chunks), {
			type: 'text/plain',
			size: 4 * 1024 * 1024,
			codec: 'deflate',
		});
		await CompressionTest.put({ id: 210, blob }).catch(() => {});
		await assert.rejects(blob.written, /not a valid deflate stream|inflated to|inflates past/);
	});

	it('fails a mid-stream-corrupt stored body on send instead of hanging and leaking the file hold', async function () {
		this.timeout(5000);
		const payload = Buffer.alloc(2 * 1024 * 1024, 'sender mid-corrupt ');
		const blob = await putBlob(220, payload, { compress: true, type: 'text/plain' });
		const filePath = getFilePathForBlob(blob);
		const onDisk = readFileSync(filePath);
		// valid deflate prefix then garbage: Z_DATA_ERROR mid-inflate, which drops zlib's write callback
		onDisk.fill(0xab, HEADER_SIZE + Math.floor((onDisk.length - HEADER_SIZE) / 2));
		writeFileSync(filePath, onDisk);
		const stored = openStoredBlobBody(blob);
		assert(stored, 'the header sniff still passes; verification is what catches the corrupt body');
		await assert.rejects(
			(async () => {
				for await (const _chunk of stored.stream()) {
					// drain
				}
			})(),
			(error) => {
				assert.equal(error.statusCode, 500, 'a corrupt stored body is a permanent (500) failure');
				return true;
			}
		);
		// the finally released the descriptor and the hold: a follow-up open succeeds rather than wedging
		const reopened = openStoredBlobBody(blob);
		assert(reopened, 'the failed send must not leave the file held');
		reopened.close();
	});

	it('a compressed read whose file is repaired (replaced) during the writer wait is retryable, not corrupt', async function () {
		this.timeout(10000);
		const payload = Buffer.from('repaired during read '.repeat(3000));
		const blob = await putBlob(230, payload, { compress: true, type: 'text/plain' });
		const filePath = getFilePathForBlob(blob);
		const lockKey = getFileId(blob) + ':blob';

		// tear the on-disk compressed body so a reader stuck on the pre-wait inode would inflate it to a
		// permanent 500; the 8-byte header survives, so the read still sniffs DEFLATE and parks in the wait
		truncateSync(filePath, statSync(filePath).size - 20);
		assert.ok(store.tryLock(lockKey));
		const record = await CompressionTest.get(230);
		let settled = false;
		const pendingRead = streamToBuffer(record.blob.stream())
			.then(
				() => ({ ok: true }),
				(error) => ({ ok: false, status: error.statusCode })
			)
			.finally(() => (settled = true));
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(settled, false, 'the read must be parked on the writer lock');

		// a repair publishes a fresh, healthy UNCOMPRESSED file over the path (rename), then releases the lock
		const healthy = Buffer.concat([Buffer.alloc(HEADER_SIZE), payload]);
		healthy.writeUIntBE(payload.length, 2, 6); // UNCOMPRESSED_TYPE (0) header carrying the real content size
		writeFileSync(filePath + '.repair', healthy);
		renameSync(filePath + '.repair', filePath);
		store.unlock(lockKey);

		const result = await pendingRead;
		assert.equal(result.ok, false, 'the read must not serve the orphaned torn inode');
		assert.equal(result.status, 503, 'a file replaced during the wait is retryable (503), not permanent (500)');

		// a fresh read now serves the repaired, healthy content
		assert((await streamToBuffer((await CompressionTest.get(230)).blob.stream())).equals(payload));
	});

	it('fails an auto-compressed write whose content length disagrees with its declared size', async () => {
		setCompressionConfig({ default: { codec: 'deflate' } });
		// A source that ends cleanly having delivered fewer bytes than the size declared on the blob. The
		// header is stamped from the declared size up front, so without the finish-time byte-count check the
		// file would commit and inflate to the wrong length — a permanent 500 no reader could ever serve,
		// where an uncompressed short body would read as retryable-incomplete.
		const blob = createBlob(Readable.from([Buffer.alloc(20000, 'x')]), { type: 'text/plain' });
		blob.size = 50000;
		await CompressionTest.put({ id: 240, blob }).catch(() => {});
		await assert.rejects(blob.written, /deflated 20000 bytes but its header declares 50000/);
	});
});
