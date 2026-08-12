// QA-809 — blob-bearing record writer for the drop-kill-window sweep. Blob content is
// generated server-side (deterministic HMAC stream) so every write is a genuine file-backed
// blob (well above the 8KB FILE_STORAGE_THRESHOLD).
//
// NOTE on qa805's fixture bug (flagged by the task brief): qa805's store() did a `table.get(id)`
// readback immediately after `table.put(...)` inside the same request/transaction, which derefs
// null on LMDB (no read-your-writes within an open txn). This fixture never reads back inside
// store() -- verification is a SEPARATE request (separate transaction), issued by the test only
// after the store request has resolved (i.e. after commit).

import { createHash, createHmac } from 'node:crypto';

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

// POST /Blob809/ { action: 'store'|'verify', db, table, id, size, seed }
export class Blob809 extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const action = body && body.action;
		const db = body && body.db;
		const table = db && databases[db] && databases[db][body.table];
		if (!table) {
			const ctx = this.getContext();
			if (ctx && ctx.response) ctx.response.status = 400;
			return { ok: false, reason: 'unknown-table', db, table: body && body.table };
		}
		switch (action) {
			case 'store':
				return this.store(table, body);
			case 'verify':
				return this.verify(table, body);
			default: {
				const ctx = this.getContext();
				if (ctx && ctx.response) ctx.response.status = 400;
				return { ok: false, reason: 'unknown-action', action };
			}
		}
	}

	// Put only -- no readback. Caller can 'verify' in a later, separate request if needed.
	async store(table, body) {
		const id = String(body.id);
		const size = Number(body.size) || 256 * 1024;
		const seed = body.seed == null ? id : String(body.seed);
		const expected = patternBuffer(seed, size);
		await table.put({ id, blob: createBlob(expected, { type: 'application/octet-stream' }) });
		return { ok: true, id, expectedSha: sha256(expected) };
	}

	// Separate request/transaction -- safe read-your-writes across commits on both engines.
	async verify(table, body) {
		const id = String(body.id);
		const rec = await table.get(id);
		if (!rec) return { ok: true, present: false, id };
		const bytes = Buffer.from(await rec.blob.bytes());
		return { ok: true, present: true, id, readSha: sha256(bytes), size: bytes.length };
	}
}
