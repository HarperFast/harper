// QA-726 — audit/time-travel reads of a superseded record whose Blob file has been reclaimed.
//
// POST /DocOp/ endpoint, generalized over 4 isolated databases/tables (qa726a..d), supporting:
//   write      — full PUT {table, id, seed, title}; body = distinctive HMAC-pattern blob;
//                returns sha256+size so the test can byte-distinguish versions.
//   delete     — DELETE the record.
//   currentGet — read back the CURRENT record; returns {present, title, sha, size}.
//   history    — Document.getHistoryOfRecord(id), the in-process surface behind
//                read_audit_log search_type:hash_value / getRecordAtTime. For each entry
//                carrying a `content` Blob, attempt to materialize it with a bounded timeout
//                (so a hang is measured, not left open) and report sha/size/error/elapsed.
//
// Deliberately does NOT route Blob bytes through JSON.stringify (Blob.toJSON() for non-text
// types short-circuits to a placeholder description without ever touching the file — that's
// itself part of what we're probing on the ops-API read_audit_log surface, tested separately
// via raw HTTP from the test file).

import { createHash, createHmac } from 'node:crypto';

// Blob files partition per-DATABASE, not per-table, so each arm lives in its own database.
// The global `tables` export only aliases the default "data" database (resources/databases.ts
// ensureDB: `databases['data'] = tables`); non-default databases live only under `databases[db]`.
function tableFor(db) {
	const names = { qa726a: 'Document', qa726b: 'DocumentLeak', qa726c: 'DocumentDel', qa726d: 'DocumentT4' };
	const name = names[db];
	return name && databases[db] && databases[db][name];
}

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

/** Race a promise against a timeout WITHOUT ever leaving the timer armed after settling. */
function withTimeout(promise, ms) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(Object.assign(new Error(`TIMEOUT_${ms}MS`), { isTimeout: true })), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class DocOp extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const action = body && body.action;
		const id = body && String(body.id);
		const Table = tableFor(body && body.table);
		if (!Table) {
			const ctx = this.getContext();
			if (ctx && ctx.response) ctx.response.status = 400;
			return { ok: false, reason: 'unknown-table', table: body && body.table };
		}

		switch (action) {
			case 'write': {
				const size = Number(body.size) || 20 * 1024; // > FILE_STORAGE_THRESHOLD (8192) -> file-backed
				const seed = body.seed != null ? String(body.seed) : `${id}:write:${Date.now()}`;
				const data = patternBuffer(seed, size);
				const sha = sha256hex(data);
				await Table.put({
					id,
					title: body.title || seed,
					content: createBlob(data, { type: 'application/octet-stream' }),
				});
				return { ok: true, id, sha, size, seed };
			}

			case 'delete': {
				await Table.delete(id);
				return { ok: true, id, deleted: true };
			}

			case 'currentGet': {
				const rec = await Table.get(id);
				if (!rec) return { ok: true, present: false, id };
				try {
					let sha = null;
					let size = null;
					if (rec.content) {
						const bytes = Buffer.from(await rec.content.bytes());
						sha = sha256hex(bytes);
						size = bytes.length;
					}
					return { ok: true, present: true, id, title: rec.title, sha, size };
				} catch (e) {
					return { ok: false, present: true, id, readError: String((e && e.message) || e) };
				}
			}

			case 'history': {
				const timeoutMs = Number(body.timeoutMs) || 5000;
				const history = await Table.getHistoryOfRecord(id);
				const results = [];
				for (const h of history) {
					const rec = h.value;
					let outcome;
					const hasBody = rec && rec.content != null;
					if (hasBody) {
						const start = Date.now();
						try {
							const bytes = await withTimeout(rec.content.bytes(), timeoutMs);
							const buf = Buffer.from(bytes);
							outcome = {
								ok: true,
								sha: sha256hex(buf),
								size: buf.length,
								elapsedMs: Date.now() - start,
							};
						} catch (e) {
							outcome = {
								ok: false,
								error: String((e && e.message) || e),
								statusCode: e && e.statusCode,
								code: e && e.code,
								isTimeout: !!(e && e.isTimeout),
								elapsedMs: Date.now() - start,
							};
						}
					} else {
						outcome = { ok: true, noBody: true };
					}
					results.push({
						type: h.type,
						version: h.version,
						title: rec && rec.title,
						hasBody,
						outcome,
					});
				}
				return { ok: true, id, count: history.length, results };
			}

			default: {
				const ctx = this.getContext();
				if (ctx && ctx.response) ctx.response.status = 400;
				return { ok: false, reason: 'unknown-action', action };
			}
		}
	}
}
