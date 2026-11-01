/**
 * The per-request work of the dependent-read workloads, shared by Harper's Resource classes
 * (resources.js) and the Fastify routes (../../ycsb-vs-pg/pg-app/server.mjs), so both stacks parse,
 * check and compose identically and differ only in how they fetch a record.
 *
 * A record's `field0` starts with its link, `<next key>:<owner>:` (written by
 * benchmarks/ycsb/workload.mts `buildRecord`), and the rest is padding.
 *
 *   inspect: read one record, 403 unless the caller owns it, else a projection of four fields.
 *   chain:   read the record, take the next key from its contents, read that, `hops` times; one
 *            response with a projection of every record read (hops + 1 reads, each after the last).
 */

function serverError(message) {
	const error = new Error(message);
	error.statusCode = 500;
	return error;
}

/** `{ next, owner }` from a record's link; a record without one is a server error, never a default key. */
export function parseLink(record) {
	const field0 = record.field0;
	const ownerStart = typeof field0 === 'string' ? field0.indexOf(':') + 1 : 0;
	const ownerEnd = ownerStart > 1 ? field0.indexOf(':', ownerStart) : -1;
	if (ownerEnd <= ownerStart) throw serverError(`record ${record.id} has no link in field0`);
	return { next: field0.slice(0, ownerStart - 1), owner: field0.slice(ownerStart, ownerEnd) };
}

/** `{ status, body }` for an inspect of `record` by `caller`. */
export function inspectRecord(record, caller) {
	const { owner } = parseLink(record);
	if (caller !== owner) return { status: 403, body: { error: 'forbidden' } };
	return { status: 200, body: { id: record.id, owner, field1: record.field1, field2: record.field2 } };
}

/** `hops` from the query string, or undefined unless it is one digit from 0 to 8. */
export function parseHops(value) {
	return typeof value === 'string' && /^[0-8]$/.test(value) ? Number(value) : undefined;
}

/**
 * Follows `hops` links from `id`, awaiting each `fetchRecord(id)` before the next key is known, and
 * returns `{ status, body }`. A missing record ends the walk with 404.
 */
export async function chainRecords(fetchRecord, id, hops) {
	const records = new Array(hops + 1);
	let key = id;
	for (let step = 0; step <= hops; step++) {
		const record = await fetchRecord(key);
		if (!record) return { status: 404, body: { error: `${key} not found` } };
		const { next, owner } = parseLink(record);
		records[step] = { id: record.id, owner, next, field1: record.field1, field2: record.field2 };
		key = next;
	}
	return { status: 200, body: { id, hops, records } };
}
