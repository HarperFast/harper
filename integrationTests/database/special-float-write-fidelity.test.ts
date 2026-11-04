/**
 * QA-432 — content-negotiation write-path fidelity for IEEE-754 special floats.
 *
 * JSON cannot represent NaN or ±Infinity, so a JSON write bakes the JSON-spec coercion in before
 * storage sees the value and a binary body is the only way to put one in front of Harper. -0 is
 * the exception: `JSON.parse('{"x":-0}').x` is a genuine negative zero, so all three content
 * types can deliver it and all three are exercised.
 *
 * What a binary read proves, and what it does not. Reads are not served from a write-side object —
 * PrimaryRocksDatabase sets cachePuts=false and invalidates on put, so the first read decodes
 * stored bytes — which is why a binary read recovering the exact value shows storage kept it. The
 * converse does NOT hold: Harper's outbound encoders coerce on the way out too, so a value that
 * comes back changed may have been lost at ingest OR on response encoding, and this suite cannot
 * tell which. Every claim here is about the round trip; a red arm is not on its own evidence about
 * the write path, so check `server/serverHelpers/contentTypes.ts` response encoding before
 * `resources/Table.ts`.
 *
 * -0 needs the wire checked, not just the value written. Both binary encoders take an integer fast
 * path for -0 (`-0 >>> 0 === -0`), so `encode({ x: -0 })` emits unsigned integer 0 and Harper never
 * sees a negative zero — an arm built on the default encoders pins cbor-x/msgpackr behaviour while
 * appearing to pin Harper's. cbor-x emits a real float64 under alwaysUseFloat, msgpackr has no such
 * option so that map is assembled by hand, and JSON.stringify(-0) is "0" so that body is written
 * out as text. Each arm asserts its request bytes carry a real -0 before reading anything back.
 *
 * TypedDoc declares every special-float attribute, so its writes reach the per-type validation in
 * resources/Table.ts — `case 'Float': if (typeof value !== 'number')`, which admits NaN and the
 * infinities today. Doc leaves them undeclared and skips that branch entirely; running the same
 * contract against both is what would catch a tightening to a finiteness check.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/special-float-write-fidelity.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import request from 'supertest';
import { Encoder } from 'cbor-x';
import { pack as msgpackPack, unpack as msgpackUnpack } from 'msgpackr';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations; runtime resolves fine
import { waitForRouteReady } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'special-float-write-fidelity');
const skipSuite = process.platform === 'win32';
const TABLES = ['Doc', 'TypedDoc'] as const;
type TableName = (typeof TABLES)[number];

const cborCodec = new Encoder({ useRecords: false });
const cborFloatCodec = new Encoder({ useRecords: false, alwaysUseFloat: true });

const FLOAT64_NEG_ZERO = Buffer.from('8000000000000000', 'hex');

type Client = ReturnType<typeof createApiClient>;

const FIELDS = {
	nan: NaN,
	posInf: Infinity,
	negInf: -Infinity,
	normal: 3.14,
} as const;
type FieldName = keyof typeof FIELDS;

const READS = [
	{ label: 'json', accept: 'application/json' },
	{ label: 'cbor', accept: 'application/cbor' },
	{ label: 'msgpack', accept: 'application/x-msgpack' },
] as const;

function fmt(v: unknown): string {
	if (v === null) return 'null';
	if (v === undefined) return 'undefined';
	if (typeof v === 'number') {
		if (Object.is(v, -0)) return '-0';
		if (Number.isNaN(v)) return 'NaN';
		if (!Number.isFinite(v)) return v > 0 ? '+Infinity' : '-Infinity';
	}
	return JSON.stringify(v);
}

interface Cell {
	status: number;
	value: unknown;
}
const matrix: Record<string, Record<string, Record<string, Cell>>> = {};
const rowKey = (table: string, writeFormat: string) => `${table}/${writeFormat}`;

function binaryParser(res: any, cb: (err: Error | null, body: Buffer) => void) {
	const chunks: Buffer[] = [];
	res.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
	res.on('end', () => cb(null, Buffer.concat(chunks)));
	res.on('error', (e: Error) => cb(e, Buffer.alloc(0)));
}

suite(
	'Content-negotiation write-path fidelity for special floats (QA-432)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: Client;
		let restURL: string;
		let authHeaders: Record<string, string>;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
			client = createApiClient(ctx.harper);
			restURL = (client as any).restURL;
			authHeaders = { Authorization: client.headers.Authorization, Connection: 'close' };

			// A half-started server answers non-200, and breaking early would land the first PUT
			// before the table exists and report it as a write-path defect.
			for (const table of TABLES) {
				await waitForRouteReady(client, `/${table}/`, 30_000, {
					isReady: (response: { status: number }) => response.status === 200,
				});
			}
		});

		after(async () => {
			printMatrix();
			await teardownHarper(ctx);
		});

		function printMatrix() {
			console.log('\n══ QA-432 ROUND-TRIP MATRIX (one row per table x write format) ══');
			for (const key of Object.keys(matrix)) {
				console.log(`\n  ${key}:`);
				const fieldRows = matrix[key];
				const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);
				console.log('    ' + pad('field', 10) + pad('written', 12) + READS.map((r) => pad(r.label, 12)).join(''));
				for (const field of Object.keys(fieldRows)) {
					const written = FIELDS[field as FieldName];
					const cells = READS.map((r) => {
						const c = fieldRows[field][r.label];
						if (!c) return pad('n/a', 12);
						return pad(c.status >= 300 ? `HTTP${c.status}` : fmt(c.value), 12);
					});
					console.log('    ' + pad(field, 10) + pad(fmt(written), 12) + cells.join(''));
				}
			}
			console.log('');
		}

		async function writeRecord(table: TableName, id: string, writeFormat: 'cbor' | 'msgpack'): Promise<number> {
			const record: Record<string, unknown> = { id, ...FIELDS };
			const body = writeFormat === 'cbor' ? cborCodec.encode(record) : msgpackPack(record);
			const contentType = writeFormat === 'cbor' ? 'application/cbor' : 'application/x-msgpack';
			const r = await request(restURL)
				.put(`/${table}/${id}`)
				.set(authHeaders)
				.set('Content-Type', contentType)
				.send(body)
				.timeout(20_000);
			return r.status;
		}

		async function readRecord(
			table: TableName,
			id: string,
			accept: string,
			readLabel: string
		): Promise<{ status: number; decoded: any }> {
			const r = await request(restURL)
				.get(`/${table}/${id}`)
				.set(authHeaders)
				.set('Accept', accept)
				.buffer(true)
				.parse(binaryParser)
				.timeout(20_000);
			if (r.status >= 300) return { status: r.status, decoded: undefined };
			strictEqual(
				r.headers['content-type']?.split(';', 1)[0],
				accept,
				`Accept ${accept} must return the matching Content-Type, got ${r.headers['content-type']}`
			);
			const buf = r.body as unknown as Buffer;
			let decoded: any;
			if (readLabel === 'json') decoded = JSON.parse(buf.toString('utf8'));
			else if (readLabel === 'cbor') decoded = cborCodec.decode(buf);
			else decoded = msgpackUnpack(buf);
			return { status: r.status, decoded };
		}

		/** One GET per read format, so every field of a given column comes from one response. */
		async function readAllFormats(table: TableName, id: string): Promise<Record<string, Record<string, Cell>>> {
			const row: Record<string, Record<string, Cell>> = {};
			for (const { label, accept } of READS) {
				const { status, decoded } = await readRecord(table, id, accept, label);
				for (const field of Object.keys(FIELDS)) {
					(row[field] ??= {})[label] = { status, value: decoded ? decoded[field] : undefined };
				}
			}
			return row;
		}

		async function runWriteFormat(writeFormat: 'cbor' | 'msgpack') {
			for (const table of TABLES) {
				const id = `rec-${writeFormat}`;
				const writeStatus = await writeRecord(table, id, writeFormat);
				ok(writeStatus < 300, `${writeFormat} write for ${table}/${id} should not be rejected, got ${writeStatus}`);
				matrix[rowKey(table, writeFormat)] = await readAllFormats(table, id);
			}
		}

		test('CBOR write: PUT body with NaN/Infinity/-Infinity/control', async () => {
			await runWriteFormat('cbor');
		});

		test('msgpack write: PUT body with NaN/Infinity/-Infinity/control', async () => {
			await runWriteFormat('msgpack');
		});

		/** An empty matrix would make every loop below iterate zero times and pass. */
		function rows(): string[] {
			const expected = TABLES.flatMap((table) => ['cbor', 'msgpack'].map((f) => rowKey(table, f))).sort();
			deepStrictEqual(Object.keys(matrix).sort(), expected, 'every table x write format must have produced a record');
			return expected;
		}

		test('control float (3.14) is faithful on every write x read combo', () => {
			for (const row of rows()) {
				for (const { label } of READS) {
					const cell = matrix[row].normal[label];
					strictEqual(cell.status, 200, `control read ${row}->${label} should be 200`);
					strictEqual(cell.value, 3.14, `control float must round-trip via ${row}->${label}`);
				}
			}
		});

		test('NaN and +/-Infinity round-trip exactly on a binary read, and flatten to null on JSON', () => {
			const preservedFields: FieldName[] = ['nan', 'posInf', 'negInf'];
			for (const row of rows()) {
				for (const field of preservedFields) {
					const written = FIELDS[field];
					for (const readLabel of ['cbor', 'msgpack']) {
						const got = matrix[row][field][readLabel].value;
						ok(
							Object.is(got, written),
							`${field} written as ${fmt(written)} over ${row} must read back exactly over ${readLabel}, got ${fmt(got)}`
						);
					}
					const jsonVal = matrix[row][field].json.value;
					strictEqual(jsonVal, null, `${field} must flatten to null on a JSON read of ${row}, got ${fmt(jsonVal)}`);
				}
			}
		});

		/** msgpackr has no alwaysUseFloat, so this map is assembled byte by byte:
		 *  fixmap(2), "id" -> id, "negZero" -> float64 -0. */
		function msgpackBodyWithNegZero(id: string): Buffer {
			const key = (name: string) => {
				const bytes = Buffer.from(name, 'utf8');
				// fixstr only reaches 31 bytes; past that `0xa0 | length` silently wraps to a shorter string.
				ok(bytes.length <= 31, `msgpack fixstr cannot encode ${bytes.length} bytes: ${name}`);
				return Buffer.concat([Buffer.from([0xa0 | bytes.length]), bytes]);
			};
			return Buffer.concat([
				Buffer.from([0x82]),
				key('id'),
				key(id),
				key('negZero'),
				Buffer.from([0xcb]),
				FLOAT64_NEG_ZERO,
			]);
		}

		// Dropping TypedDoc's Float declarations would turn it into a second copy of Doc's
		// open-attribute path with every arm still green, so the difference is asserted.
		test('TypedDoc reaches per-type validation and Doc does not', async () => {
			const send = (table: TableName, field: string) =>
				request(restURL)
					.put(`/${table}/arming-probe-${field}`)
					.set(authHeaders)
					.set('Content-Type', 'application/json')
					.send(JSON.stringify({ id: `arming-probe-${field}`, [field]: 'not-a-number' }))
					.timeout(20_000);

			for (const field of [...Object.keys(FIELDS), 'negZero']) {
				const typed = await send('TypedDoc', field);
				strictEqual(
					typed.status,
					400,
					`declared Float ${field} must reject a non-numeric value with 400, got ${typed.status}`
				);

				const open = await send('Doc', field);
				ok(open.status < 300, `undeclared attribute ${field} must accept any value, got ${open.status}`);
			}
		});

		// Characterization, not an endorsement: this pins the complete REST round trip, not storage alone.
		test('a genuine IEEE-754 -0 on the wire does not survive the round trip', async () => {
			for (const table of TABLES) {
				const bodyFor = {
					json: {
						contentType: 'application/json',
						// JSON.stringify(-0) is "0", so the sign has to be written out as text.
						build: (id: string) => Buffer.from(`{"id":${JSON.stringify(id)},"negZero":-0}`, 'utf8'),
						marker: Buffer.from('"negZero":-0', 'utf8'),
					},
					cbor: {
						contentType: 'application/cbor',
						build: (id: string) => Buffer.from(cborFloatCodec.encode({ id, negZero: -0 })),
						marker: Buffer.concat([Buffer.from([0xfb]), FLOAT64_NEG_ZERO]),
					},
					msgpack: {
						contentType: 'application/x-msgpack',
						build: msgpackBodyWithNegZero,
						marker: Buffer.concat([Buffer.from([0xcb]), FLOAT64_NEG_ZERO]),
					},
				};

				for (const [writeFormat, { contentType, build, marker }] of Object.entries(bodyFor)) {
					const id = `rec-negzero-${writeFormat}`;
					const body = build(id);
					// The encoders' integer fast path erases -0 silently, so the wire is checked
					// rather than the value handed to encode().
					ok(
						body.includes(marker),
						`${writeFormat} request body must carry float64 -0 (${marker.toString('hex')}), got ${body.toString('hex')}`
					);

					const writeStatus = (
						await request(restURL)
							.put(`/${table}/${id}`)
							.set(authHeaders)
							.set('Content-Type', contentType)
							// supertest sends a Buffer as binary whatever the header says, so the JSON
							// body has to go out as text or Harper stores the raw bytes as the record.
							.send(contentType === 'application/json' ? body.toString('utf8') : body)
							.timeout(20_000)
					).status;
					ok(writeStatus < 300, `${table} ${writeFormat} -0 write should not be rejected, got ${writeStatus}`);

					for (const { label, accept } of READS) {
						const { status, decoded } = await readRecord(table, id, accept, label);
						strictEqual(status, 200, `${table} ${writeFormat} -0 read over ${label} should be 200`);
						const got = decoded?.negZero;
						console.log(`  [-0] ${table} write=${writeFormat} read=${label} -> ${fmt(got)}`);
						ok(
							Object.is(got, 0),
							`-0 written to ${table} over ${writeFormat} must read back as +0 over ${label}, got ${fmt(got)}`
						);
					}
				}
			}
		});
	}
);
