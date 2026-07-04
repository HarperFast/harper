// QA-P281-TTL — blob TTL eviction probe resource.
//
// Stores real file-backed blobs (~200 KB each) via createBlob() so the
// on-disk blob files are created. Exposes store/verify operations so the
// test can write records and confirm their integrity post-eviction.
//
// Blob size is above the inline-storage threshold (~8KB) so every write
// produces a real file under {dataRootDir}/blobs/{db}/...

import { createHash, createHmac } from 'node:crypto';

const { BlobTtlTest } = tables;
const BLOB_SIZE = 200 * 1024; // 200KB — always file-backed

// Deterministic non-compressible buffer derived from seed.
function patternBuffer(seed, size) {
	const out = Buffer.allocUnsafe(size);
	let off = 0;
	let counter = 0;
	while (off < size) {
		const block = createHmac('sha256', String(seed)).update(String(counter++)).digest();
		const n = Math.min(block.length, size - off);
		block.copy(out, off, 0, n);
		off += n;
	}
	return out;
}

function sha256hex(buf) {
	return createHash('sha256').update(buf).digest('hex');
}

export class BlobTtlRes extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const action = body && body.action;
		if (action === 'store') return this.store(body);
		if (action === 'verify') return this.verify(body);
		if (action === 'replace') return this.replace(body);
		if (action === 'count') return this.count(body);
		const ctx = this.getContext();
		if (ctx && ctx.response) ctx.response.status = 400;
		return { ok: false, reason: 'unknown-action', action };
	}

	async store(body) {
		const id = String(body.id);
		const seed = body.seed != null ? String(body.seed) : id;
		const buf = patternBuffer(seed, BLOB_SIZE);
		const expectedSha = sha256hex(buf);

		await BlobTtlTest.put({
			id,
			payload: createBlob(buf, { type: 'application/octet-stream' }),
			sha256: expectedSha,
			size: BLOB_SIZE,
		});

		return { ok: true, id, expectedSha };
	}

	// Store a record then immediately replace its blob with a fresh one.
	// This exercises the pre-replace unlink path AND TTL on the replacement.
	async replace(body) {
		const id = String(body.id);
		const seed1 = `${id}-v1`;
		const seed2 = `${id}-v2`;
		const buf1 = patternBuffer(seed1, BLOB_SIZE);
		const buf2 = patternBuffer(seed2, BLOB_SIZE);
		const sha1 = sha256hex(buf1);
		const sha2 = sha256hex(buf2);

		// Write v1
		await BlobTtlTest.put({
			id,
			payload: createBlob(buf1, { type: 'application/octet-stream' }),
			sha256: sha1,
			size: BLOB_SIZE,
		});
		// Overwrite with v2 (old blob file should be unlinked ~500ms later by deleteBlob)
		await BlobTtlTest.put({
			id,
			payload: createBlob(buf2, { type: 'application/octet-stream' }),
			sha256: sha2,
			size: BLOB_SIZE,
		});

		return { ok: true, id, sha1, sha2 };
	}

	// Live record count — confirms TTL eviction actually removed the rows.
	async count() {
		let n = 0;
		const ids = [];
		for await (const rec of BlobTtlTest.search({})) {
			n++;
			if (ids.length < 20) ids.push(rec.id);
		}
		return { ok: true, count: n, ids };
	}

	async verify(body) {
		const id = String(body.id);
		const rec = await BlobTtlTest.get(id);
		if (!rec) return { ok: true, present: false, id };
		const bytes = Buffer.from(await rec.payload.bytes());
		return {
			ok: true,
			present: true,
			id,
			storedSha: rec.sha256,
			readSha: sha256hex(bytes),
			size: bytes.length,
			match: sha256hex(bytes) === rec.sha256,
		};
	}
}
