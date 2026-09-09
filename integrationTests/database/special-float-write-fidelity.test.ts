/**
 * QA-432 — content-negotiation write-path fidelity for IEEE-754 special floats.
 *
 * A JSON request body cannot represent NaN, ±Infinity or -0, so a JSON write bakes the JSON-spec
 * coercions in before storage ever sees the value. A CBOR or msgpack body can carry them, so a
 * binary write is the only way to put one in front of Harper at all. The record is then read back
 * over CBOR, msgpack and JSON.
 *
 * What a binary read proves, and what it does not. Reads are not served from a write-side object —
 * PrimaryRocksDatabase sets cachePuts=false and invalidates on put, so the first read decodes
 * stored bytes — which is why a binary read recovering the exact value shows storage kept it. The
 * converse does NOT hold: Harper's outbound CBOR/msgpack encoders coerce on the way out too, so a
 * value that comes back changed may have been lost at ingest OR on response encoding, and this
 * suite cannot tell which. Every claim below is therefore about the round trip. A red arm here is
 * not on its own evidence about the write path; check `server/serverHelpers/contentTypes.ts`
 * response encoding before `resources/Table.ts`.
 *
 * The contract this pins:
 *   - NaN / +Infinity / -Infinity round-trip exactly on a binary read, after a binary write, on
 *     both an open table and one whose attributes are declared Float.
 *   - A JSON read of those flattens to null, per the JSON spec.
 *   - A genuine IEEE-754 -0 on the wire does not survive the round trip: every read, binary and
 *     JSON, returns +0. Benign (-0 === 0 for nearly all consumers) but a real asymmetry against
 *     NaN and the infinities, so it is pinned rather than left to drift.
 *
 * -0 needs the wire checked, not just the value written. Both encoders take an integer fast path
 * for -0 (`-0 >>> 0 === -0`), so `encode({ x: -0 })` emits unsigned integer 0 and Harper never
 * sees a negative zero — a -0 arm built on the default encoders pins cbor-x/msgpackr behaviour
 * while appearing to pin Harper's. cbor-x emits a real float64 under alwaysUseFloat; msgpackr has
 * no such option, so the msgpack body for that field is assembled by hand. Either way the arm
 * asserts the request bytes carry float64 -0 before it reads anything back.
 *
 * TypedDoc exists because the open-table path skips per-attribute validation entirely. A declared
 * Float goes through the `typeof value !== 'number'` branch in resources/Table.ts, which admits
 * NaN and the infinities today; running the same contract against it is what would catch a
 * tightening to a finiteness check.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/special-float-write-fidelity.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { Encoder } from 'cbor-x';
import { pack as msgpackPack, unpack as msgpackUnpack } from 'msgpackr';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

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

			// A half-started server answers this probe non-200, so anything but 200 keeps polling:
			// breaking early lands the first PUT before the table exists and reports it as a
			// write-path defect.
			const deadline = Date.now() + 30_000;
			for (const table of TABLES) {
				let lastStatus: number | string = 'no response';
				let ready = false;
				while (!ready && Date.now() < deadline) {
					try {
						const probe = await client.reqRest(`/${table}/`).timeout(3_000);
						lastStatus = probe.status;
						ready = probe.status === 200;
					} catch (error) {
						lastStatus = (error as Error).message;
					}
					if (!ready) await sleep(250);
				}
				if (!ready) throw new Error(`${table} route never became ready within 30s; last probe: ${lastStatus}`);
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

		/** A failed write arm leaves the matrix empty, which would make every loop below iterate
		 *  zero times and pass having measured nothing. */
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

		test('a genuine IEEE-754 -0 on the wire does not survive the round trip', async () => {
			for (const table of TABLES) {
				const bodyFor = {
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
					// Without this the encoder's integer fast path turns the arm into a test of
					// cbor-x/msgpackr rather than of Harper, and it still passes.
					ok(
						body.includes(marker),
						`${writeFormat} request body must carry float64 -0 (${marker.toString('hex')}), got ${body.toString('hex')}`
					);

					const writeStatus = (
						await request(restURL)
							.put(`/${table}/${id}`)
							.set(authHeaders)
							.set('Content-Type', contentType)
							.send(body)
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
