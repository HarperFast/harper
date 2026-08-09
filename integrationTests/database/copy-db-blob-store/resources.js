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

export class Seed extends Resource {
	static loadAsInstance = false;
	async post(body) {
		const key = String(body.key);
		if (String(body?.kind ?? 'blob') === 'inline') {
			await Doc.put({ key, note: String(body.note ?? key) });
			return { ok: true, key, kind: 'inline' };
		}
		const bytes = patternBuffer(key, Number(body.size) || 256 * 1024);
		await Doc.put({ key, payload: createBlob(bytes, { type: 'application/octet-stream' }), note: sha256(bytes) });
		return { ok: true, key, kind: 'blob', sha: sha256(bytes) };
	}
}

// Read-back over the current database; also serves as the readiness probe.
export class Verify extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const key = String(typeof query?.get === 'function' ? query.get('key') : query?.key);
		try {
			const rec = await Doc.get(key);
			if (!rec) return { ok: true, present: false, key };
			if (!rec.payload) return { ok: true, present: true, key, hasPayload: false };
			const bytes = Buffer.from(await rec.payload.bytes());
			return { ok: true, present: true, key, hasPayload: true, size: bytes.length, match: sha256(bytes) === rec.note };
		} catch (e) {
			return { ok: false, key, error: String(e?.message ?? e).slice(0, 200) };
		}
	}
}
