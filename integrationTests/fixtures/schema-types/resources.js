// schema-types fixture resource
//
// BrotliStore: accepts raw bytes via POST /BrotliStore/:id, stores them as a
// Blob in BrotliBlob, and returns them via GET with Content-Encoding pass-through.
// Covers Case 2 of the schema-type integration tests.

export class BrotliStore extends Resource {
	static loadAsInstance = false;

	// POST /BrotliStore/:id  body=<raw bytes>
	// Reads X-Harper-Encoding header as the encoding signal (NOT Content-Encoding —
	// that triggers HTTP-level decompression before the body reaches Harper).
	async post(query, body) {
		const id = String(query.id || 'default');
		// The context IS the request object; headers.asObject is the raw header map.
		const ctx = this.getContext();
		const encoding = ctx?.headers?.asObject?.['x-harper-encoding'] ?? null;
		const bytes = Buffer.isBuffer(body) ? body : body instanceof Uint8Array ? Buffer.from(body) : null;
		if (!bytes) return new Response(null, { status: 400 });
		await tables.BrotliBlob.put({
			id,
			payload: createBlob(bytes, { type: 'application/octet-stream' }),
			encoding,
		});
		return new Response(null, { status: 204 });
	}

	// GET /BrotliStore/:id — return the stored blob bytes with Content-Encoding.
	async get(query) {
		const id = String(query.id || 'default');
		const rec = await tables.BrotliBlob.get(id);
		if (!rec) return new Response(null, { status: 404 });
		const headers = { 'Content-Type': 'application/octet-stream' };
		if (rec.encoding) headers['Content-Encoding'] = rec.encoding;
		const bytes = Buffer.from(await rec.payload.bytes());
		return new Response(bytes, { status: 200, headers });
	}
}
