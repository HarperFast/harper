// QA-720 blob-reclamation-ledger probe resource.
//
// Generates deterministic, non-compressible blobs server-side (real file-backed blobs, not
// inlined -- FILE_STORAGE_THRESHOLD is 8192 bytes, see resources/blob.ts), stores them via the
// ordinary Table put/get/delete API, and exposes store/verify/list/overwriteNonBlob actions used
// by every arm. All integrity is verified SERVER-SIDE by reading stored bytes back and
// checksumming them. drop_table/drop_database/bulk-delete-by-search are driven directly via the
// operations API from the test (not through this resource).

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

function tableFor(db, name) {
	return databases[db][name];
}

// POST /Ops/ { action, db, table, ... }
export class Ops extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const action = body && body.action;
		switch (action) {
			case 'store':
				return this.store(body);
			case 'overwriteNonBlob':
				return this.overwriteNonBlob(body);
			case 'delete':
				return this.deleteKey(body);
			case 'verify':
				return this.verify(body);
			case 'list':
				return this.list(body);
			default: {
				const ctx = this.getContext();
				if (ctx && ctx.response) ctx.response.status = 400;
				return { ok: false, reason: 'unknown-action', action };
			}
		}
	}

	// Store (or overwrite-with-a-new-blob) a deterministic blob. `seed` controls the bytes, so
	// calling this twice with the same key but a different seed IS the overwrite-with-new-blob arm.
	async store(body) {
		const table = tableFor(body.db, body.table);
		const key = String(body.key);
		const size = Number(body.size) || 32 * 1024;
		const seed = body.seed == null ? `${key}:${process.hrtime.bigint()}` : String(body.seed);
		const expected = patternBuffer(seed, size);
		const expectedSha = sha256(expected);

		await table.put({
			key,
			payload: createBlob(expected, { type: 'application/octet-stream' }),
			sha256: expectedSha,
		});

		const rec = await table.get(key);
		const readBytes = Buffer.from(await rec.payload.bytes());
		return {
			ok: true,
			key,
			expectedSha,
			storedSha: sha256(readBytes),
			match: sha256(readBytes) === expectedSha,
		};
	}

	// Full-record replace that OMITS the payload field entirely -- the blob field is removed
	// from the record, not just left alone. Row survives; blob reference does not.
	async overwriteNonBlob(body) {
		const table = tableFor(body.db, body.table);
		const key = String(body.key);
		const tag = body.tag == null ? 'no-blob' : String(body.tag);
		await table.put({ key, sha256: tag });
		return { ok: true, key, tag };
	}

	async deleteKey(body) {
		const table = tableFor(body.db, body.table);
		const key = String(body.key);
		await table.delete(key);
		return { ok: true, key, deleted: true };
	}

	// Reads the record back and reports both presence and blob health, distinguishing:
	//  - absent (present:false)
	//  - present, no blob field (hasPayload:false) -- e.g. after overwriteNonBlob
	//  - present, blob field present and readable+matching (hasPayload:true, dangling:false)
	//  - present, blob field present but UNREADABLE (dangling:true) -- the row references a
	//    missing/corrupt backing file: a dangling ref, strictly worse than a plain orphan file.
	async verify(body) {
		const table = tableFor(body.db, body.table);
		const key = String(body.key);
		const rec = await table.get(key);
		if (!rec) return { ok: true, present: false, key };
		if (rec.payload == null) {
			return { ok: true, present: true, hasPayload: false, key, sha256: rec.sha256 };
		}
		try {
			const bytes = Buffer.from(await rec.payload.bytes());
			return {
				ok: true,
				present: true,
				hasPayload: true,
				dangling: false,
				key,
				storedSha: rec.sha256,
				readSha: sha256(bytes),
				match: sha256(bytes) === rec.sha256,
			};
		} catch (error) {
			return {
				ok: true,
				present: true,
				hasPayload: true,
				dangling: true,
				key,
				error: String(error && error.message ? error.message : error),
			};
		}
	}

	// Full base-table scan (index-independent oracle): every live key + whether it carries a blob.
	async list(body) {
		const table = tableFor(body.db, body.table);
		const out = [];
		for await (const r of table.search({})) out.push({ key: r.key, hasPayload: r.payload != null, sha256: r.sha256 });
		return out;
	}
}
