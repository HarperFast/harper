/**
 * QA-432 — content-negotiation WRITE-path fidelity for IEEE-754 special floats.
 *
 * A JSON request body cannot represent NaN, ±Infinity or -0, so a JSON write bakes the JSON-spec
 * coercions in before storage ever sees the value. A CBOR or msgpack body can carry them, which
 * makes ingest itself observable: PUT a binary body, then read the record back over CBOR, msgpack
 * and JSON. A binary read that recovers the exact value proves storage kept it and only the JSON
 * serializer flattens it; a binary read that does not proves the value was lost at ingest, because
 * no read format can resurrect what was never stored. Reads are not served from a write-side
 * object: PrimaryRocksDatabase sets cachePuts=false and invalidates on put, so the first read
 * decodes stored bytes.
 *
 * The contract this pins:
 *   - NaN / +Infinity / -Infinity survive a binary write and round-trip exactly on a binary read.
 *   - A JSON read of those flattens to null, per the JSON spec — read-path, not storage.
 *   - A genuine IEEE-754 -0 on the wire does not survive the round trip: every read, binary
 *     included, returns +0. Benign (-0 === 0 for nearly all consumers) but a real asymmetry
 *     against NaN and the infinities, so it is pinned rather than left to drift.
 *
 * -0 needs the wire checked, not just the value written. Both encoders take an integer fast path
 * for -0 (`-0 >>> 0 === -0`), so `encode({ x: -0 })` emits unsigned integer 0 and Harper never
 * sees a negative zero — a -0 arm built on the default encoders pins cbor-x/msgpackr behaviour
 * while appearing to pin Harper's. cbor-x emits a real float64 under alwaysUseFloat; msgpackr has
 * no such option, so the msgpack body for that field is assembled by hand. Either way the arm
 * asserts the request bytes carry float64 -0 (0xfb / 0xcb + sign bit) before it reads anything
 * back.
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
const TABLE = 'Doc';

const cborCodec = new Encoder({ useRecords: false });
// The only encoder setting that puts a real float64 -0 on the wire; see the header.
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
			let lastStatus: number | string = 'no response';
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest(`/${TABLE}/`).timeout(3_000);
					lastStatus = probe.status;
					if (probe.status === 200) return;
				} catch (error) {
					lastStatus = (error as Error).message;
				}
				await sleep(250);
			}
			throw new Error(`${TABLE} route never became ready within 30s; last probe: ${lastStatus}`);
		});

		after(async () => {
			await teardownHarper(ctx);
			printMatrix();
		});

		function printMatrix() {
			console.log('\n══ QA-432 WRITE-PATH FIDELITY MATRIX (per write-format record) ══');
			for (const writeFormat of Object.keys(matrix)) {
				console.log(`\n  write=${writeFormat}:`);
				const fieldRows = matrix[writeFormat];
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

		async function writeRecord(id: string, writeFormat: 'cbor' | 'msgpack'): Promise<number> {
			const record: Record<string, unknown> = { id, ...FIELDS };
			const body = writeFormat === 'cbor' ? cborCodec.encode(record) : msgpackPack(record);
			const contentType = writeFormat === 'cbor' ? 'application/cbor' : 'application/x-msgpack';
			const r = await request(restURL)
				.put(`/${TABLE}/${id}`)
				.set(authHeaders)
				.set('Content-Type', contentType)
				.send(body)
				.timeout(20_000);
			return r.status;
		}

		async function readRecord(
			id: string,
			accept: string,
			readLabel: string
		): Promise<{ status: number; decoded: any }> {
			const r = await request(restURL)
				.get(`/${TABLE}/${id}`)
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

		/** Every cell of a row comes from one response, so a row is one snapshot of the record. */
		async function readAllFormats(id: string): Promise<Record<string, Record<string, Cell>>> {
			const row: Record<string, Record<string, Cell>> = {};
			for (const { label, accept } of READS) {
				const { status, decoded } = await readRecord(id, accept, label);
				for (const field of Object.keys(FIELDS)) {
					(row[field] ??= {})[label] = { status, value: decoded ? decoded[field] : undefined };
				}
			}
			return row;
		}

		async function runWriteFormat(writeFormat: 'cbor' | 'msgpack') {
			const id = `rec-${writeFormat}`;
			const writeStatus = await writeRecord(id, writeFormat);
			ok(writeStatus < 300, `${writeFormat} write for ${id} should not be rejected, got ${writeStatus}`);
			matrix[writeFormat] = await readAllFormats(id);
		}

		test('CBOR write: PUT body with NaN/Infinity/-Infinity/control', async () => {
			await runWriteFormat('cbor');
		});

		test('msgpack write: PUT body with NaN/Infinity/-Infinity/control', async () => {
			await runWriteFormat('msgpack');
		});

		/** A failed write arm leaves the matrix empty, which would make every loop below iterate
		 *  zero times and pass having measured nothing. */
		function writeFormats(): string[] {
			const formats = Object.keys(matrix);
			deepStrictEqual(formats.sort(), ['cbor', 'msgpack'], 'both write formats must have produced a record');
			return formats;
		}

		test('control float (3.14) is faithful on every write x read combo', () => {
			for (const writeFormat of writeFormats()) {
				for (const { label } of READS) {
					const cell = matrix[writeFormat].normal[label];
					strictEqual(cell.status, 200, `control read ${writeFormat}->${label} should be 200`);
					strictEqual(cell.value, 3.14, `control float must round-trip via ${writeFormat}->${label}`);
				}
			}
		});

		test('NaN and +/-Infinity survive a binary write and round-trip on a binary read', () => {
			const preservedFields: FieldName[] = ['nan', 'posInf', 'negInf'];
			for (const writeFormat of writeFormats()) {
				for (const field of preservedFields) {
					const written = FIELDS[field];
					for (const readLabel of ['cbor', 'msgpack']) {
						const got = matrix[writeFormat][field][readLabel].value;
						ok(
							Object.is(got, written),
							`${field} written as ${fmt(written)} over ${writeFormat} must read back exactly over ` +
								`${readLabel}, got ${fmt(got)} — a binary read cannot resurrect a value storage lost, ` +
								`so this failing means the write path coerced it`
						);
					}
					const jsonVal = matrix[writeFormat][field].json.value;
					strictEqual(
						jsonVal,
						null,
						`${field} must flatten to null on a JSON read (via ${writeFormat} write), got ${fmt(jsonVal)}`
					);
				}
			}
		});

		/** msgpackr has no alwaysUseFloat, so this row of the map is assembled byte by byte:
		 *  fixmap(2), "id" -> id, "negZero" -> float64 -0. */
		function msgpackBodyWithNegZero(id: string): Buffer {
			const key = (name: string) => Buffer.concat([Buffer.from([0xa0 | name.length]), Buffer.from(name, 'utf8')]);
			return Buffer.concat([
				Buffer.from([0x82]),
				key('id'),
				key(id),
				key('negZero'),
				Buffer.from([0xcb]),
				FLOAT64_NEG_ZERO,
			]);
		}

		// Where the sign is dropped is not observable from here: Harper's CBOR/msgpack response
		// encoders take the same integer fast path on the way out, so a faithfully stored -0 and a
		// coerced one look identical over HTTP. The arm therefore pins the round trip, not the
		// ingest step.
		test('a genuine IEEE-754 -0 on the wire does not survive the round trip', async () => {
			const bodies = {
				cbor: {
					contentType: 'application/cbor',
					body: Buffer.from(cborFloatCodec.encode({ id: 'rec-negzero-cbor', negZero: -0 })),
					marker: Buffer.concat([Buffer.from([0xfb]), FLOAT64_NEG_ZERO]),
				},
				msgpack: {
					contentType: 'application/x-msgpack',
					body: msgpackBodyWithNegZero('rec-negzero-msgpack'),
					marker: Buffer.concat([Buffer.from([0xcb]), FLOAT64_NEG_ZERO]),
				},
			};

			for (const [writeFormat, { contentType, body, marker }] of Object.entries(bodies)) {
				const id = `rec-negzero-${writeFormat}`;
				// Arming check: without it the encoder's integer fast path silently turns this into a
				// test of cbor-x/msgpackr rather than of Harper.
				ok(
					body.includes(marker),
					`${writeFormat} request body must carry float64 -0 (${marker.toString('hex')}), got ${body.toString('hex')}`
				);

				const writeStatus = (
					await request(restURL)
						.put(`/${TABLE}/${id}`)
						.set(authHeaders)
						.set('Content-Type', contentType)
						.send(body)
						.timeout(20_000)
				).status;
				ok(writeStatus < 300, `${writeFormat} -0 write should not be rejected, got ${writeStatus}`);

				for (const readLabel of ['cbor', 'msgpack']) {
					const accept = READS.find((r) => r.label === readLabel)!.accept;
					const { status, decoded } = await readRecord(id, accept, readLabel);
					strictEqual(status, 200, `${writeFormat} -0 read over ${readLabel} should be 200`);
					const got = decoded?.negZero;
					console.log(`  [-0] write=${writeFormat} read=${readLabel} -> ${fmt(got)}`);
					ok(
						Object.is(got, 0),
						`-0 written over ${writeFormat} must read back as +0 over ${readLabel}, got ${fmt(got)}`
					);
				}
			}
		});
	}
);
