// QA-802 — Blob GC vs audit-log expiry (harper#708) probe resource.
//
// Stores deterministic, non-compressible blobs (so files are real file-backed blobs, not
// inlined) in Doc.payload and exposes store/verify. Record deletion is driven from the test
// via the operations API's `sql` op (matching the issue's exact repro: "deleted via SQL"),
// not through this resource, so the on-the-wire path is identical to #708's report.

import { createHash, createHmac } from 'node:crypto';

const { Doc } = tables;

// Deterministic ~`size`-byte buffer derived from `seed` (HMAC-SHA256 keystream) — unique,
// non-compressible bytes per seed so every store/overwrite writes genuinely fresh content.
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

function sha256(buf) {
	return createHash('sha256').update(buf).digest('hex');
}

// POST /DocOps/  { action, ... }
export class DocOps extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const action = body && body.action;
		switch (action) {
			case 'store':
				return this.store(body);
			case 'verify':
				return this.verify(body);
			default: {
				const ctx = this.getContext();
				if (ctx && ctx.response) ctx.response.status = 400;
				return { ok: false, reason: 'unknown-action', action };
			}
		}
	}

	// Store (or overwrite) a deterministic blob-bearing record.
	async store(body) {
		const key = String(body.key);
		const size = Number(body.size) || 512 * 1024;
		const seed = body.seed == null ? `${key}:${process.hrtime.bigint()}` : String(body.seed);
		const expected = patternBuffer(seed, size);
		const expectedSha = sha256(expected);

		await Doc.put({
			key,
			payload: createBlob(expected, { type: 'application/octet-stream' }),
			sha256: expectedSha,
			note: body.note == null ? null : String(body.note),
		});

		return { ok: true, key, seed, expectedSha };
	}

	async verify(body) {
		const key = String(body.key);
		const rec = await Doc.get(key);
		if (!rec) return { ok: true, present: false, key };
		const bytes = Buffer.from(await rec.payload.bytes());
		return {
			ok: true,
			present: true,
			key,
			storedSha: rec.sha256,
			readSha: sha256(bytes),
			size: bytes.length,
			match: sha256(bytes) === rec.sha256,
		};
	}
}
