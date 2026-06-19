// QA-147 — source resources for CacheWT (write-through) and CacheRO (read-only get()).
//
// The in-test origin (started by the test) is the SYSTEM OF RECORD. Each source method issues
// an HTTP request to http://127.0.0.1:<QA147_ORIGIN_PORT>/item/<id>:
//   GET    -> read-through population (both tables define this)
//   PUT    -> write-through create/update  (CacheWT only)
//   DELETE -> write-through delete          (CacheWT only)
//
// CacheRO deliberately omits put/delete so we can observe what Harper does with a cache write
// when the source CANNOT write through (the silent-divergence candidate per QA-124's read-only
// source shape).
//
// All origin mutations are recorded server-side via the /__writes counter endpoint, so the test
// reads back EXACTLY which writes propagated (op + id + value), independent of Harper's response.

const http = require('node:http');

const { CacheWT, CacheRO } = tables;

function originPort() {
	return Number(process.env.QA147_ORIGIN_PORT || 0);
}

// Generic origin request helper. method GET/PUT/DELETE; body optional JSON.
function originRequest(method, id, body) {
	return new Promise((resolve, reject) => {
		const data = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
		const req = http.request(
			{
				host: '127.0.0.1',
				port: originPort(),
				method,
				path: `/item/${encodeURIComponent(id)}`,
				agent: false,
				headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
			},
			(res) => {
				const chunks = [];
				res.on('data', (c) => chunks.push(c));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					if (res.statusCode >= 200 && res.statusCode < 300) {
						let parsed;
						try {
							parsed = text ? JSON.parse(text) : undefined;
						} catch {
							parsed = { value: text };
						}
						resolve({ statusCode: res.statusCode, parsed });
					} else if (res.statusCode === 404) {
						resolve({ statusCode: 404, parsed: undefined });
					} else {
						const err = new Error(`origin ${method} returned ${res.statusCode}: ${text.slice(0, 120)}`);
						err.statusCode = res.statusCode;
						reject(err);
					}
				});
			}
		);
		req.on('error', (err) => reject(err));
		if (data) req.write(data);
		req.end();
	});
}

async function getFromOrigin(id) {
	const { statusCode, parsed } = await originRequest('GET', id);
	if (statusCode === 404 || !parsed) return undefined;
	return { id: String(id), value: parsed.value, fetchedAt: Date.now() };
}

// CacheWT — full read-through + write-through (put/delete forwarded to origin).
CacheWT.sourcedFrom(
	class extends Resource {
		async get() {
			return getFromOrigin(this.getId());
		}
		// Table._writeUpdate calls the static Resource.put(id, recordUpdate, context); the static
		// wrapper resolves the resource by id and invokes THIS instance method as put(record, query).
		// So arg1 is the record being written; this.getId() gives the key. (resources/Resource.ts:113-134)
		async put(record /*, query */) {
			const id = this.getId();
			// The record arrives as the request envelope ({contentType, data:<Buffer of the JSON body>});
			// decode the body so the origin stores the real value (proves value-fidelity of write-through).
			let value;
			try {
				if (record && record.data && (Buffer.isBuffer(record.data) || record.data.type === 'Buffer')) {
					const buf = Buffer.isBuffer(record.data) ? record.data : Buffer.from(record.data.data);
					value = JSON.parse(buf.toString('utf8')).value;
				} else if (record && typeof record === 'object' && 'value' in record) {
					value = record.value;
				} else {
					value = record;
				}
			} catch {
				value = undefined;
			}
			await originRequest('PUT', id, { id: String(id), value });
		}
		async delete(/* query */) {
			await originRequest('DELETE', this.getId());
		}
	}
);

// CacheRO — read-through ONLY. No put/delete defined: write-through is impossible.
CacheRO.sourcedFrom(
	class extends Resource {
		async get() {
			return getFromOrigin(this.getId());
		}
	}
);
