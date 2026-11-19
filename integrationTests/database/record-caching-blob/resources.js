// Backing endpoint for the Blob-attribute record-caching test.
//
// POST /BlobOp/ supports:
//   put       — create/overwrite the whole record: {id, size, seed}; blob content is a
//               deterministic keystream so the test can independently recompute and
//               byte-verify without buffering server-generated randomness anywhere.
//   replace   — PATCH replacing just the payload (and its sha256) with new bytes: {id, size, seed}
//   delete    — delete the record (triggers blob unlink)
//   reconcile — server-side scan: for every LIVE record, read payload bytes and hash them,
//               compare to the stored sha256. Surfaces any record whose blob file diverged
//               from what was written (readError / mismatch), independent of the REST/cache path.

import { createHash, createHmac } from 'node:crypto';

const { BlobRec } = tables;

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

export class BlobOp extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const action = body && body.action;
		const id = body && String(body.id);
		try {
			switch (action) {
				case 'put': {
					const size = Number(body.size) || 150 * 1024;
					const seed = body.seed != null ? String(body.seed) : `${id}:put:0`;
					const data = patternBuffer(seed, size);
					const sha = sha256hex(data);
					await BlobRec.put({
						id,
						payload: createBlob(data, { type: 'application/octet-stream' }),
						sha256: sha,
					});
					return { ok: true, id, sha, size };
				}

				case 'replace': {
					const size = Number(body.size) || 150 * 1024;
					const seed = body.seed != null ? String(body.seed) : `${id}:replace:${Date.now()}`;
					const data = patternBuffer(seed, size);
					const sha = sha256hex(data);
					await BlobRec.patch(id, {
						payload: createBlob(data, { type: 'application/octet-stream' }),
						sha256: sha,
					});
					return { ok: true, id, sha, size };
				}

				case 'delete': {
					await BlobRec.delete(id);
					return { ok: true, id, deleted: true };
				}

				case 'reconcile': {
					let total = 0;
					let intact = 0;
					let mismatched = 0;
					let readError = 0;
					const bad = [];
					for await (const rec of BlobRec.search({})) {
						total++;
						try {
							const bytes = Buffer.from(await rec.payload.bytes());
							const sha = sha256hex(bytes);
							if (sha === rec.sha256) {
								intact++;
							} else {
								mismatched++;
								bad.push({ id: rec.id, expected: rec.sha256, got: sha, len: bytes.length });
							}
						} catch (e) {
							readError++;
							bad.push({ id: rec.id, error: String((e && e.message) || e) });
						}
					}
					return { ok: true, total, intact, mismatched, readError, bad: bad.slice(0, 20) };
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
			return {
				ok: false,
				error: String((e && e.message) || e),
				stack: String(e && e.stack)
					.split('\n')
					.slice(0, 4),
			};
		}
	}
}
