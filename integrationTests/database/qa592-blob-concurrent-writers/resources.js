// QA-592 — blob x concurrency: N concurrent writers REPLACE the same blob record.
//
// Payloads are generated server-side from (writer, seq) so multi-MB bodies never cross
// the wire on every request — only small JSON in/out. Each write stamps its own sha256
// into the SAME record as the blob in one atomic put(), so a reader can self-check
// consistency without knowing which writer/seq is "current": if the declared sha256
// doesn't match the bytes read back from the same snapshot, that snapshot is torn/spliced.

import { createHash, createHmac } from 'node:crypto';

const { Asset } = tables;

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

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

// POST /AssetOps/  { action, key?, writer?, seq?, size?, seed? }
export class AssetOps extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const action = body && body.action;
		try {
			switch (action) {
				case 'write': {
					const key = String(body.key);
					const writer = Number(body.writer) || 0;
					const seq = Number(body.seq) || 0;
					const size = Number(body.size) || 1024 * 1024;
					const data = patternBuffer(`${writer}:${seq}`, size);
					const sha256 = sha256hex(data);
					await Asset.put({
						id: key,
						data: createBlob(data, { type: 'application/octet-stream' }),
						writer,
						seq,
						sha256,
					});
					return { ok: true, key, writer, seq, sha256, size };
				}

				case 'read': {
					const key = String(body.key);
					const rec = await Asset.get(key);
					if (!rec) return { ok: true, found: false };
					const declaredSha = rec.sha256;
					let bytesLen = null;
					let actualSha = null;
					let readError = null;
					try {
						const bytes = Buffer.from(await rec.data.bytes());
						bytesLen = bytes.length;
						actualSha = sha256hex(bytes);
					} catch (e) {
						readError = String((e && e.message) || e);
					}
					return {
						ok: true,
						found: true,
						writer: rec.writer,
						seq: rec.seq,
						declaredSha,
						bytesLen,
						actualSha,
						shaMatch: readError ? null : actualSha === declaredSha,
						readError,
					};
				}

				case 'delete': {
					const key = String(body.key);
					await Asset.delete(key);
					return { ok: true, key };
				}

				case 'count': {
					let n = 0;
					const ids = [];
					for await (const rec of Asset.search({})) {
						n++;
						ids.push(rec.id);
					}
					return { ok: true, count: n, ids };
				}

				default: {
					const ctx = this.getContext();
					if (ctx && ctx.response) ctx.response.status = 400;
					return { ok: false, reason: 'unknown-action', action };
				}
			}
		} catch (e) {
			const ctx = this.getContext();
			if (ctx && ctx.response) ctx.response.status = 500;
			return { ok: false, error: String((e && e.message) || e) };
		}
	}
}
