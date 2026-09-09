// QA-672 resource — probe endpoint for blob-backed-page-cache x in-place-upgrade x TTL.
//
// Exposes POST /Ops672/ with actions:
//   store     — insert a record with an explicit expiresAt (now + ttlMs, may be negative to
//               plant a record already past its expiry at write time)
//   update    — re-PUT an existing id with brand-new content + a fresh expiresAt (simulates a
//               post-upgrade write to an old-version record; probes old-blob-file release)
//   get       — read one record back; reports present/absent + byte-for-byte sha check + metadata
//   reconcile — same as `get` but for a batch of {id, sha} pairs
//   count     — count of currently-live records (table scan)

import { createHash, createHmac } from 'node:crypto';

const { PageCache672 } = tables;

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

export class Ops672 extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const action = body && body.action;

		switch (action) {
			case 'store': {
				const id = String(body.id);
				const size = Number(body.size) || 64 * 1024;
				const ttlMs = Number(body.ttlMs);
				const contentType = body.contentType || 'application/octet-stream';
				const seed = `${id}-${body.gen || 0}-${Date.now()}`;
				const data = patternBuffer(seed, size);
				const sha = sha256hex(data);
				const expiresAt = Date.now() + ttlMs;
				const renderedAt = new Date().toISOString();
				await PageCache672.put({
					id,
					body: createBlob(data, { type: contentType }),
					sha256: sha,
					contentType,
					renderedAt,
					expiresAt,
				});
				return { ok: true, id, sha, size, expiresAt, renderedAt, contentType };
			}

			case 'update': {
				const id = String(body.id);
				const size = Number(body.size) || 64 * 1024;
				const ttlMs = Number(body.ttlMs);
				const contentType = body.contentType || 'application/octet-stream';
				const seed = `${id}-update-${body.gen || 1}-${Date.now()}`;
				const data = patternBuffer(seed, size);
				const sha = sha256hex(data);
				const expiresAt = Date.now() + ttlMs;
				const renderedAt = new Date().toISOString();
				await PageCache672.put({
					id,
					body: createBlob(data, { type: contentType }),
					sha256: sha,
					contentType,
					renderedAt,
					expiresAt,
				});
				return { ok: true, id, sha, size, expiresAt, renderedAt, contentType };
			}

			case 'get': {
				const id = String(body.id);
				const rec = await PageCache672.get(id);
				if (!rec) return { ok: true, present: false, id };
				try {
					const bytes = Buffer.from(await rec.body.bytes());
					const readSha = sha256hex(bytes);
					return {
						ok: true,
						present: true,
						id,
						readSha,
						storedSha: rec.sha256,
						shaMatch: readSha === rec.sha256,
						bytesLen: bytes.length,
						contentType: rec.contentType,
						renderedAt: rec.renderedAt,
						expiresAt: rec.expiresAt,
					};
				} catch (e) {
					return {
						ok: true,
						present: true,
						id,
						readError: String((e && e.message) || e),
						shaMatch: false,
						expiresAt: rec.expiresAt,
					};
				}
			}

			case 'reconcile': {
				const keys = Array.isArray(body.keys) ? body.keys : [];
				const results = [];
				let intact = 0;
				let missing = 0;
				let danglingRef = 0;
				for (const { id, sha } of keys) {
					const rec = await PageCache672.get(id);
					if (!rec) {
						missing++;
						results.push({ id, present: false });
						continue;
					}
					try {
						const bytes = Buffer.from(await rec.body.bytes());
						const readSha = sha256hex(bytes);
						const match = sha ? readSha === sha : readSha === rec.sha256;
						if (match) intact++;
						else danglingRef++;
						results.push({ id, present: true, shaMatch: match, readSha, storedSha: rec.sha256 });
					} catch (e) {
						danglingRef++;
						results.push({ id, present: true, readError: String((e && e.message) || e), shaMatch: false });
					}
				}
				return { ok: true, total: intact + missing + danglingRef, intact, missing, danglingRef, records: results };
			}

			case 'count': {
				let n = 0;
				for await (const _ of PageCache672.search({})) n++;
				return { ok: true, count: n };
			}

			// Bypasses the lazy expiresAt read-filter (and its evict-on-read side effect — see
			// Table.ts ensureLoadedFromSource) via includeExpired:true, so we can observe GROUND
			// TRUTH: is the primaryStore entry for `id` still physically present (rawPresent), and
			// if so, can its blob body still be read (readError reveals a dangling/mirror-failure
			// reference: record present, file gone)? A plain `get`/`reconcile` on an expired record
			// always reports present:false regardless of physical state, which can't distinguish
			// "genuinely evicted" from "filtered-but-still-resident" — this action can.
			case 'raw': {
				const id = String(body.id);
				let found = null;
				for await (const rec of PageCache672.search({
					conditions: [{ attribute: 'id', comparator: 'equal', value: id }],
					includeExpired: true,
				})) {
					found = rec;
					break;
				}
				if (!found) return { ok: true, rawPresent: false, id };
				let bytesLen = null;
				let readSha = null;
				let readError = null;
				try {
					const bytes = Buffer.from(await found.body.bytes());
					bytesLen = bytes.length;
					readSha = sha256hex(bytes);
				} catch (e) {
					readError = String((e && e.message) || e);
				}
				return {
					ok: true,
					rawPresent: true,
					id,
					storedSha: found.sha256,
					expiresAt: found.expiresAt,
					pastDue: typeof found.expiresAt === 'number' ? found.expiresAt < Date.now() : null,
					bytesLen,
					readSha,
					readError,
					shaMatch: readError ? false : readSha === found.sha256,
				};
			}

			default: {
				const ctx = this.getContext();
				if (ctx && ctx.response) ctx.response.status = 400;
				return { ok: false, reason: 'unknown-action', action };
			}
		}
	}
}
