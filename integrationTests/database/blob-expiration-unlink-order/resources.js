// QA-174 — Blob unlink / record-delete ordering under expiration-scan force-commit.
//
// Probes the removeEntry() ordering during the background expiration sweep:
//   deleteBlobsInObject(value)  -> schedules a setTimeout(unlink, deletionDelay)
//                                  on the blob FILE, decoupled from the txn
//   store.remove(key, options)  -> queues the record delete INTO the per-eviction
//                                  DatabaseTransaction (which the long-txn monitor
//                                  can force-commit / the engine can abort)
//
// If the unlink fires but the record delete does NOT commit, a LIVE record is left
// pointing at a DELETED blob file (orphaned-ref DEFECT). This resource lets the test
// (a) store file-backed blobs with verifiable content, and (b) read every surviving
// record's blob back server-side and report whether the bytes are still intact, which
// is exactly how an orphaned-ref would surface (read of a unlinked file fails/empties).

import { createHash, createHmac } from 'node:crypto';

const { BlobExpire, BlobKeep } = tables;

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

const tableFor = (target) => (target === 'keep' ? BlobKeep : BlobExpire);

// POST /BlobOps/  { action, table?, key?, size?, seed? }
export class BlobOps extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const action = body && body.action;
		const tbl = tableFor(body && body.table);

		switch (action) {
			case 'store': {
				const key = String(body.key);
				const size = Number(body.size) || 64 * 1024;
				const seed = body.seed != null ? String(body.seed) : key;
				const data = patternBuffer(seed, size);
				const expectedSha = sha256hex(data);
				await tbl.put({
					id: key,
					data: createBlob(data, { type: 'application/octet-stream' }),
					sha256: expectedSha,
					size,
				});
				// Don't read the blob bytes back here: on LMDB the file-backed blob save can
				// still be in flight immediately after put() resolves, which would race the
				// read. Integrity is verified later via the `reconcile` action (post-settle).
				return { ok: true, key, expectedSha, size };
			}

			// Read EVERY record currently in the table and try to materialize its blob.
			// Reports, per record: present, byte-length, sha, and whether the read
			// succeeded. An orphaned-ref (live record, unlinked file) shows up here as
			// readError / size-mismatch / sha-mismatch on a record that still exists.
			case 'reconcile': {
				const records = [];
				let total = 0;
				let intact = 0;
				let orphanedRef = 0; // live record whose blob bytes could not be read / are wrong
				for await (const rec of tbl.search({})) {
					total++;
					const id = rec.id;
					const declaredSha = rec.sha256;
					let entry = { id, declaredSha, present: true };
					try {
						const blob = rec.data;
						if (blob == null) {
							entry.readError = 'null-blob';
							orphanedRef++;
						} else {
							const bytes = Buffer.from(await blob.bytes());
							entry.bytesLen = bytes.length;
							entry.readSha = sha256hex(bytes);
							entry.shaMatch = declaredSha == null ? null : entry.readSha === declaredSha;
							if (bytes.length === 0 || entry.shaMatch === false) orphanedRef++;
							else intact++;
						}
					} catch (e) {
						entry.readError = String((e && e.message) || e);
						orphanedRef++;
					}
					records.push(entry);
				}
				return { ok: true, table: body.table || 'expire', total, intact, orphanedRef, records };
			}

			case 'count': {
				let n = 0;
				for await (const _ of tbl.search({})) n++;
				return { ok: true, table: body.table || 'expire', count: n };
			}

			default: {
				const ctx = this.getContext();
				if (ctx && ctx.response) ctx.response.status = 400;
				return { ok: false, reason: 'unknown-action', action };
			}
		}
	}
}
