/**
 * harper#1484 — computed-scalar default surfacing (Fix A) + cyclic-enumerable serialization guard (Fix B).
 *
 *  Fix A: REST GET with no explicit select must include @computed *scalar* attributes (their getters are
 *         non-enumerable, so JSON.stringify used to silently drop them). Table-typed computeds/relationships
 *         stay lazy by default.
 *  Fix B: @enumerable relationships that form a cycle (Author<->Book, and the Category self-loop) must
 *         serialize as { <primaryKey> } reference stubs rather than overflowing the stack / 500ing.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/resources/computed-and-cyclic-serialization.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { encode as encodeCbor, decode as decodeCbor } from 'cbor-x';
import { unpack } from 'msgpackr';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'computed-and-cyclic-serialization');
const skipSuite = process.platform === 'win32';
const ENGINE = process.env.HARPER_STORAGE_ENGINE || 'rocksdb(default)';
const NATIVE_DATE = new Date('1843-01-01T00:00:00.000Z');
const NATIVE_BYTES = Buffer.from([0, 1, 127, 128, 255]);

suite(
	`harper#1484 computed + cyclic serialization [engine=${ENGINE}]`,
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let httpURL: string;
		let auth: string;
		let client: ReturnType<typeof createApiClient>;

		async function rest(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
			const r = await fetch(`${httpURL}${path}`, {
				method,
				headers: { 'Content-Type': 'application/json', 'Authorization': auth },
				body: body == null ? undefined : JSON.stringify(body),
			});
			let parsed: any = null;
			try {
				parsed = await r.json();
			} catch {
				/* ignore */
			}
			return { status: r.status, body: parsed };
		}

		async function putCbor(path: string, body: unknown): Promise<number> {
			const response = await fetch(`${httpURL}${path}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/cbor', 'Authorization': auth },
				// @ts-expect-error Node's fetch BodyInit type does not accept Buffer<ArrayBufferLike>.
				body: encodeCbor(body),
			});
			return response.status;
		}

		async function getEncoded(path: string, mediaType: 'application/cbor' | 'application/x-msgpack') {
			const response = await fetch(`${httpURL}${path}`, {
				headers: { Accept: mediaType, Authorization: auth },
			});
			const encoded = Buffer.from(await response.arrayBuffer());
			return {
				status: response.status,
				body: mediaType === 'application/cbor' ? decodeCbor(encoded) : unpack(encoded),
			};
		}

		function assertNativeValues(body: any, tableName: string, mediaType: string) {
			strictEqual(body?.displayName, tableName, `${mediaType} must include the computed field`);
			ok(body?.details?.createdAt instanceof Date, `${mediaType} must preserve Date as a native timestamp`);
			ok(ArrayBuffer.isView(body?.details?.bytes), `${mediaType} must preserve Bytes as a binary view`);
			deepStrictEqual(
				Array.from(body.details.bytes),
				Array.from(NATIVE_BYTES),
				`${mediaType} must preserve the original bytes`
			);
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			auth = client.headers.Authorization;

			await rest('PUT', '/Author/1', { id: '1', name: 'Ada' });
			await rest('PUT', '/Book/10', { id: '10', authorId: '1', title: 'Analytical Engine' });
			// Category self-loop: 1 -> 2 -> 1
			await rest('PUT', '/Category/1', { id: '1', name: 'root', parentId: '2' });
			await rest('PUT', '/Category/2', { id: '2', name: 'child', parentId: '1' });
			// Node link cycle via an unconstrained (`Any`) @computed resolver: A -> B -> A
			await rest('PUT', '/Node/A', { id: 'A', linkId: 'B' });
			await rest('PUT', '/Node/B', { id: 'B', linkId: 'A' });
			// Ref link cycle via a *typed-scalar* (`String`) @computed resolver that returns a live entity: X -> Y -> X
			await rest('PUT', '/Ref/X', { id: 'X', linkId: 'Y' });
			await rest('PUT', '/Ref/Y', { id: 'Y', linkId: 'X' });
			for (const tableName of ['NativeValues', 'NativeStructValues']) {
				strictEqual(
					await putCbor(`/${tableName}/1`, {
						id: '1',
						name: tableName,
						details: { createdAt: NATIVE_DATE, bytes: NATIVE_BYTES },
					}),
					204
				);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		// ---- Fix A: computed scalar on the default read path ----

		test('A1: default GET includes @computed scalar (displayName)', async () => {
			const { status, body } = await rest('GET', '/Author/1');
			strictEqual(status, 200);
			strictEqual(body?.name, 'Ada');
			strictEqual(body?.displayName, 'Ada', 'computed scalar must be surfaced without an explicit select');
		});

		// ---- Fix B: cyclic @enumerable serialization does not overflow ----

		test('B1: mutual enumerable cycle (Author<->Book) serializes with a reference stub', async () => {
			const { status, body } = await rest('GET', '/Author/1');
			strictEqual(status, 200, 'must not 500/overflow on a cyclic-enumerable read');
			// Author.books is enumerable -> each Book.author is enumerable -> back to this Author = cycle.
			const book = Array.isArray(body?.books) ? body.books[0] : undefined;
			ok(book, 'enumerable books should be present in serialization');
			deepStrictEqual(book?.author, { id: '1' }, 'cyclic back-edge collapses to a { id } reference stub');
		});

		test('B2: self-referential tree (Category.parent) does not overflow', async () => {
			const { status, body } = await rest('GET', '/Category/1');
			strictEqual(status, 200, 'self-loop must not overflow');
			strictEqual(body?.parent?.id, '2');
			deepStrictEqual(body?.parent?.parent, { id: '1' }, 'tree cycle collapses to a reference stub');
		});

		test('B3: unconstrained @computed returning a live entity cycle does not overflow', async () => {
			const { status, body } = await rest('GET', '/Node/A');
			strictEqual(status, 200, 'untyped-computed runtime cycle must not overflow (guarded, not fast path)');
			strictEqual(body?.linked?.id, 'B', 'the computed live entity is surfaced');
			deepStrictEqual(body?.linked?.linked, { id: 'A' }, 'runtime cycle collapses to a reference stub');
		});

		test('B4: typed-scalar @computed returning a live entity cycle does not overflow (guarded path)', async () => {
			// Regression for the review follow-up: a `String`-typed @computed whose resolver returns a live
			// struct took the raw fast path before the fix (only `Any`/untyped computeds were guarded) and
			// overflowed. It must now route through the guarded path regardless of the declared type.
			const { status, body } = await rest('GET', '/Ref/X');
			strictEqual(status, 200, 'a typed-scalar computed returning a live struct must be guarded, not fast-path');
			strictEqual(body?.linked?.id, 'Y', 'the computed live entity is surfaced');
			deepStrictEqual(body?.linked?.linked, { id: 'X' }, 'runtime cycle collapses to a reference stub');
		});

		// ---- Fix C: guarded traversal preserves native values for binary encoders ----

		for (const [label, mediaType] of [
			['CBOR', 'application/cbor'],
			['MessagePack', 'application/x-msgpack'],
		] as const) {
			test(`C: ${label} preserves nested Date/Bytes for msgpackr and structon records`, async () => {
				for (const tableName of ['NativeValues', 'NativeStructValues']) {
					const { status, body } = await getEncoded(`/${tableName}/1`, mediaType);
					strictEqual(status, 200);
					assertNativeValues(body, tableName, mediaType);
				}
			});
		}
	}
);
