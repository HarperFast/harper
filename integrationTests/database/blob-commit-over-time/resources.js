// #2062 — a record write whose blob is still streaming when the open-transaction limit expires.
//
// The blob save runs in the commit's pre-commit phase, so the transaction sits in commit() until
// the last byte lands. The long-transaction monitor used to poison it there, dropping the write
// and unlinking the pre-saved blob file underneath it.
//
// Two details make the transaction reach that state:
//   - a read first: the monitor only tracks a context transaction once a read has opened a read
//     transaction on it (getReadTxn early-returns once a write already created the handle), so a
//     write-first request is never seen by the monitor at all.
//   - the source is fed AFTER the handler returns, so the wall time is spent in the commit rather
//     than in the handler.
import { PassThrough } from 'node:stream';

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// POST /SlowBlobWrite/ { id, chunks, chunkSize, chunkDelay }
export class SlowBlobWrite extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const options = body || {};
		const id = options.id;
		const chunks = Number(options.chunks) || 20;
		const chunkSize = Number(options.chunkSize) || 65536;
		const chunkDelay = Number(options.chunkDelay) || 100;
		await tables.Doc.get('__seed__');
		const source = new PassThrough();
		const blob = createBlob(source, { type: 'application/octet-stream' });
		(async () => {
			for (let i = 0; i < chunks; i++) {
				source.write(Buffer.alloc(chunkSize, i % 251));
				await sleep(chunkDelay);
			}
			source.end();
		})().catch((error) => source.destroy(error));
		await tables.Doc.put({ id, size: chunks * chunkSize, blob });
		return { ok: true, id, size: chunks * chunkSize };
	}
}

// GET /ReadBlob/<id> — read the committed blob back server-side (a separate request, so a
// separate transaction), reporting the byte count actually readable from the file.
export class ReadBlob extends Resource {
	static loadAsInstance = false;
	async get(_query) {
		const id = this.getId();
		const record = await tables.Doc.get(id);
		if (!record) return { present: false, id };
		const bytes = Buffer.from(await record.blob.bytes());
		return { present: true, id, size: record.size, blobBytes: bytes.length };
	}
}
