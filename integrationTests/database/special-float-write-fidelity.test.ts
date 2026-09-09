/**
 * QA-432 — content-negotiation WRITE-path fidelity for IEEE-754 special floats.
 *
 * A JSON request body cannot represent NaN, ±Infinity or -0, so a JSON write bakes the
 * JSON-spec coercions in before storage ever sees the value. CBOR and msgpack bodies CAN
 * represent them, which makes the write path itself observable: PUT a binary body carrying
 * the special values, then read the record back over all three surfaces (CBOR, msgpack,
 * JSON). A binary read that recovers the exact value proves storage kept it and only the
 * JSON serializer flattens it; a binary read that does not proves the value was lost at
 * ingest, because no read format can resurrect what was never stored.
 *
 * The contract this pins (from QA-432):
 *   - NaN / +Infinity / -Infinity survive a binary write and round-trip exactly on a binary read.
 *   - A JSON read of those flattens to null, per the JSON spec — read-path, not storage.
 *   - -0 loses its sign on the binary WRITE path: every read, binary included, returns +0.
 *     Benign (-0 === 0 for nearly all consumers) but a real asymmetry, so it is pinned
 *     explicitly rather than left to drift.
 *   - No special value is ever silently replaced by a WRONG finite number, on any surface.
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

// useToJSON:false so the encoder emits the raw IEEE-754 special values instead of
// going through a lossy toJSON() path; useRecords:false keeps the wire format simple.
const cborCodec = new Encoder({ useRecords: false, useToJSON: false });

type Client = ReturnType<typeof createApiClient>;

const FIELDS = {
	nan: NaN,
	posInf: Infinity,
	negInf: -Infinity,
	negZero: -0,
	normal: 3.14, // control — must always survive faithfully
} as const;
type FieldName = keyof typeof FIELDS;

const READS = [
	{ label: 'json', accept: 'application/json' },
	{ label: 'cbor', accept: 'application/cbor' },
	{ label: 'msgpack', accept: 'application/x-msgpack' },
] as const;

/** Same-value check that distinguishes NaN and -0 (unlike ===). */
function sameValue(a: unknown, b: unknown): boolean {
	return Object.is(a, b);
}

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
// matrix[writeFormat][field][readLabel] = Cell
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

			// Readiness poll (component pre-installed; do NOT restartHttpWorkers — races per QA-179 notes).
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest(`/${TABLE}/`).timeout(3_000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready */
				}
				await sleep(250);
			}
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

		/** Write one record (all FIELDS) via CBOR or msgpack body; return write status. */
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

		/** Read the whole record back in a given Accept encoding, decode with the matching codec. */
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

		async function runWriteFormat(writeFormat: 'cbor' | 'msgpack') {
			const id = `rec-${writeFormat}`;
			const writeStatus = await writeRecord(id, writeFormat);
			ok(writeStatus < 300, `${writeFormat} write for ${id} should not be rejected, got ${writeStatus}`);

			matrix[writeFormat] = {};
			for (const field of Object.keys(FIELDS) as FieldName[]) {
				matrix[writeFormat][field] = {};
				for (const { label, accept } of READS) {
					const { status, decoded } = await readRecord(id, accept, label);
					matrix[writeFormat][field][label] = { status, value: decoded ? decoded[field] : undefined };
				}
			}
		}

		test('CBOR write: PUT body with NaN/Infinity/-Infinity/-0/control', async () => {
			await runWriteFormat('cbor');
		});

		test('msgpack write: PUT body with NaN/Infinity/-Infinity/-0/control', async () => {
			await runWriteFormat('msgpack');
		});

		/** Vacuity floor: every analysis arm below reads the matrix the two write arms fill in.
		 *  Without this, a failed write arm leaves it empty and every loop below iterates zero
		 *  times — green, having measured nothing. */
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
							sameValue(got, written),
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

		// D-254: the one write-path coercion. Pinned so a change of behaviour is visible, not
		// because -0 vs +0 matters to a consumer.
		test('-0 loses its sign on the write path: every read, binary included, returns +0', () => {
			for (const writeFormat of writeFormats()) {
				for (const { label } of READS) {
					const got = matrix[writeFormat]['negZero'][label].value;
					ok(sameValue(got, 0), `-0 written over ${writeFormat} must read back as +0 over ${label}, got ${fmt(got)}`);
				}
			}
		});

		test('no special value is silently substituted with a wrong finite number', () => {
			const specialFields: FieldName[] = ['nan', 'posInf', 'negInf'];
			for (const writeFormat of writeFormats()) {
				for (const field of specialFields) {
					for (const { label } of READS) {
						const v = matrix[writeFormat][field][label].value;
						const isAcceptable = v === null || (typeof v === 'number' && (Number.isNaN(v) || !Number.isFinite(v)));
						ok(
							isAcceptable,
							`DEFECT: ${writeFormat} write, field=${field}, read=${label}: expected null or the special ` +
								`value itself, got ${fmt(v)} — silent numeric corruption`
						);
					}
				}
			}
		});
	}
);
