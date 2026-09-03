// A Blob must be constructed inside Harper, so seeding runs here rather than over the wire.
// Bytes are HMAC-derived per key: non-compressible, so they land as file-backed blobs rather
// than being inlined into the record.
import { createHash, createHmac } from 'node:crypto';

const { Doc } = tables;

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
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const DEFAULT_SEED_SIZE = 256 * 1024;
const MAX_SEED_SIZE = 4 * 1024 * 1024;

// `loadAsInstance = false` dispatches instance methods as (query, data) — with (data) alone every
// seeded field reads as undefined, which silently writes one record under the key "undefined".
export class Seed extends Resource {
	static loadAsInstance = false;
	async post(_query, body) {
		const key = String(body.key);
		if (String(body?.kind ?? 'blob') === 'inline') {
			await Doc.put({ key, note: String(body.note ?? key) });
			return { ok: true, key, kind: 'inline' };
		}
		const requested = Number(body.size) || DEFAULT_SEED_SIZE;
		const bytes = patternBuffer(key, Math.min(Math.max(requested, 1), MAX_SEED_SIZE));
		const sha = sha256(bytes);
		await Doc.put({ key, payload: createBlob(bytes, { type: 'application/octet-stream' }), note: sha });
		return { ok: true, key, kind: 'blob', size: bytes.length, sha };
	}
}

// Read-back over the current database; also serves as the readiness probe. Reports the blob's own
// sha256 rather than whether it matches the record's `note`, so the caller compares against the
// value seeding returned instead of against another field of the same (possibly corrupt) record.
export class Verify extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const key = String(typeof query?.get === 'function' ? query.get('key') : query?.key);
		try {
			const rec = await Doc.get(key);
			if (!rec) return { ok: true, present: false, key };
			if (!rec.payload) return { ok: true, present: true, key, hasPayload: false, note: rec.note };
			const bytes = Buffer.from(await rec.payload.bytes());
			return { ok: true, present: true, key, hasPayload: true, size: bytes.length, note: rec.note, sha: sha256(bytes) };
		} catch (e) {
			return { ok: false, key, error: String(e?.message ?? e).slice(0, 200) };
		}
	}
}
