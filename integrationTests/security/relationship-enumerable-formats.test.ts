/**
 * @enumerable relationships follow related-table read permissions on every response format (anchors harper#3316,
 * docs/reference/users-and-roles/overview.md "Reading a @relationship attribute"; originated as qa-explorer SQA-153 / SP-109).
 *
 * SQA-153: the documented related-table read contract (`docs/reference/users-and-roles/overview.md:279-280`:
 * reading a `@relationship` attribute needs `read` on the related table; REST `select()` and `*` leave the
 * relationship out; with attribute_permissions the related record holds only the readable attributes) must
 * hold for `@enumerable` relationships — which ARE part of a default read — on every response format.
 * Companion to SP-108 (plain relationships). Schema: Order.customer (from, @enumerable) and Order.notes
 * (to, one-to-many, @enumerable). Role 1 = Order only; role 2 = Order + Customer{id,name}; nothing on Note.
 * Formats: json, cbor, msgpack, ndjson, csv. Paths: default read (record + collection), select(*),
 * select(*,customer), explicit sub-select. Super-user arms are the live positive control: on every format the
 * default read and select(*) carry all three sentinels, so an arm that withholds them for a role is withholding
 * something the path does serialize.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { decode as cborDecode, decodeMultiple as cborDecodeMultiple } from 'cbor-x';
import { unpack as msgpackUnpack, unpackMultiple as msgpackUnpackMultiple } from 'msgpackr';
// @ts-expect-error utils/client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/relationship-enumerable-formats');
const ROLE1 = 'sqa153_orders_only';
const USER1 = 'sqa153_orders_user';
const ROLE2 = 'sqa153_orders_custname';
const USER2 = 'sqa153_custname_user';
// non-super principal that can read every table in full: discriminates super-only from readable-in-full behaviour
const ROLE3 = 'sqa153_read_all';
const USER3 = 'sqa153_read_all_user';
const PASS = `sqa153-${Math.random().toString(36).slice(2)}`;
const CUST_NAME = 'SENTINEL-CUSTNAME-7f3a';
const CUST_EMAIL = 'SENTINEL-EMAIL-9c1d@example.test';
const NOTE_TEXT = 'SENTINEL-NOTE-4b8e';
const ALL_SENTINELS = [CUST_NAME, CUST_EMAIL, NOTE_TEXT];

type Kind = 'json' | 'cbor' | 'msgpack' | 'ndjson';
interface R {
	status: number;
	buf: Buffer;
	ct: string;
}
const slice = (s: string, n = 700) => (s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s);

suite(
	'SQA-153 @enumerable relationships follow related-table permissions on every response format',
	(ctx: ContextWithHarper) => {
		let host: string, port: number, adminAuth: string;
		const auth: Record<string, string> = {};
		const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

		const send = (path: string, authz: string | null, accept: string): Promise<R> =>
			new Promise((done, fail) => {
				const headers: Record<string, string> = { Accept: accept, Connection: 'close' };
				if (authz) headers.Authorization = authz;
				const req = httpRequest({ host, port, method: 'GET', path, agent: false, headers }, (res) => {
					const chunks: Buffer[] = [];
					res.on('data', (c) => chunks.push(Buffer.from(c)));
					res.on('end', () =>
						done({ status: res.statusCode!, buf: Buffer.concat(chunks), ct: String(res.headers['content-type'] ?? '') })
					);
					res.on('error', fail);
				});
				req.on('error', fail);
				req.end();
			});

		/** decode per format into a JS structure; throws on a decoder error so the arm fails loudly */
		const decodeBody = (kind: Kind, r: R): unknown => {
			if (kind === 'json') return JSON.parse(r.buf.toString('utf8'));
			if (kind === 'cbor') {
				try {
					return cborDecode(r.buf);
				} catch {
					return cborDecodeMultiple(r.buf);
				}
			}
			if (kind === 'msgpack') {
				try {
					return msgpackUnpack(r.buf);
				} catch {
					return msgpackUnpackMultiple(r.buf);
				}
			}
			return r.buf
				.toString('utf8')
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l));
		};
		/** every object in the decoded structure that looks like an Order row (has `item`) */
		const findOrders = (value: unknown, out: any[] = []): any[] => {
			if (Array.isArray(value)) for (const v of value) findOrders(v, out);
			else if (value && typeof value === 'object') {
				if ('item' in (value as any)) out.push(value);
				else for (const v of Object.values(value as any)) findOrders(v, out);
			}
			return out;
		};
		const rawHas = (r: R, s: string) => r.buf.includes(Buffer.from(s, 'utf8'));
		const sentinelsIn = (r: R, decodedText: string, sentinels: readonly string[]) =>
			sentinels.filter((s) => decodedText.includes(s) || rawHas(r, s));

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: 1 }, authentication: { authorizeLocal: false } },
				env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
			});
			const u = new URL(ctx.harper.httpURL);
			host = u.hostname;
			port = Number(u.port);
			adminAuth = basic(ctx.harper.admin.username, ctx.harper.admin.password);
			auth.r1 = basic(USER1, PASS);
			auth.r2 = basic(USER2, PASS);
			auth.r3 = basic(USER3, PASS);
			const api = createApiClient(ctx.harper);
			await api
				.req()
				.send({
					operation: 'insert',
					schema: 'data',
					table: 'Customer',
					records: [{ id: 'c1', name: CUST_NAME, email: CUST_EMAIL }],
				})
				.expect(200);
			await api
				.req()
				.send({
					operation: 'insert',
					schema: 'data',
					table: 'Order',
					records: [
						{ id: 'o1', item: 'widget', customerId: 'c1' },
						{ id: 'o2', item: 'gadget', customerId: 'c1' },
					],
				})
				.expect(200);
			await api
				.req()
				.send({
					operation: 'insert',
					schema: 'data',
					table: 'Note',
					records: [{ id: 'n1', orderId: 'o1', text: NOTE_TEXT }],
				})
				.expect(200);
			const orderOnly = { read: true, insert: false, update: false, delete: false, attribute_permissions: [] };
			const custName = {
				read: true,
				insert: false,
				update: false,
				delete: false,
				attribute_permissions: [
					{ attribute_name: 'id', read: true, insert: false, update: false, delete: false },
					{ attribute_name: 'name', read: true, insert: false, update: false, delete: false },
				],
			};
			const mk = async (role: string, user: string, tables: any) => {
				await api
					.req()
					.send({ operation: 'add_role', role, permission: { super_user: false, data: { tables } } })
					.expect(200);
				await api.req().send({ operation: 'add_user', username: user, password: PASS, role, active: true }).expect(200);
			};
			await mk(ROLE1, USER1, { Order: orderOnly });
			await mk(ROLE2, USER2, { Order: orderOnly, Customer: custName });
			const readAll = { read: true, insert: false, update: false, delete: false, attribute_permissions: [] };
			await mk(ROLE3, USER3, { Order: readAll, Customer: readAll, Note: readAll });
			let ready = 0;
			for (let i = 0; i < 60 && ready !== 200; i++) {
				ready = (await send('/Order/o1', adminAuth, 'application/json')).status;
				if (ready !== 200) await new Promise((x) => setTimeout(x, 500));
			}
			strictEqual(ready, 200, 'readiness: admin GET /Order/o1 answers 200');
		});
		after(async () => {
			await teardownHarper(ctx);
		});

		test('P0 preconditions: 401 without credentials; role 1 denied Customer and Note directly; role 2 denied Note', async () => {
			strictEqual((await send('/Order/o1', null, 'application/json')).status, 401);
			strictEqual((await send('/Customer/c1', auth.r1, 'application/json')).status, 403);
			strictEqual((await send('/Note/n1', auth.r1, 'application/json')).status, 403);
			strictEqual((await send('/Note/n1', auth.r2, 'application/json')).status, 403);
			strictEqual((await send('/Order/o1', auth.r1, 'application/json')).status, 200);
			strictEqual((await send('/Order/o1', auth.r2, 'application/json')).status, 200);
		});

		const formats: [Kind, string][] = [
			['json', 'application/json'],
			['cbor', 'application/cbor'],
			['msgpack', 'application/x-msgpack'],
			['ndjson', 'application/x-ndjson'],
		];
		const defaultPaths = [
			'/Order/',
			'/Order/o1',
			'/Order/?select(*)',
			'/Order/o1?select(*)',
			'/Order/?select(*,customer)',
		];
		const explicitPath = '/Order/?select(id,customer{name,email},notes{text})';

		for (const [kind, accept] of formats) {
			test(`${kind} CONTROL super: explicit sub-select ${explicitPath} carries every sentinel (detection live on the explicit path)`, async () => {
				const r = await send(explicitPath, adminAuth, accept);
				strictEqual(r.status, 200, slice(r.buf.toString('utf8')));
				const text = JSON.stringify(decodeBody(kind, r));
				console.log(`${kind} CONTROL super explicit: bytes=${r.buf.length} decoded=${slice(text)}`);
				deepStrictEqual(
					sentinelsIn(r, text, ALL_SENTINELS),
					ALL_SENTINELS,
					`${kind} super explicit: sentinels missing`
				);
			});
			test(`${kind} CONTROL super: default read and select(*) carry every @enumerable sentinel (detection live on this path)`, async () => {
				for (const path of defaultPaths) {
					const r = await send(path, adminAuth, accept);
					strictEqual(r.status, 200, `${path}: ${slice(r.buf.toString('utf8'))}`);
					const decoded = decodeBody(kind, r);
					const text = JSON.stringify(decoded);
					const orders = findOrders(decoded);
					console.log(
						`${kind} CONTROL super ${path}: bytes=${r.buf.length} orders=${orders.length} decoded=${slice(text)}`
					);
					ok(
						orders.some((o) => o.id === 'o1'),
						`${kind} super ${path}: o1 missing`
					);
					const found = sentinelsIn(r, text, ALL_SENTINELS);
					deepStrictEqual(
						found,
						ALL_SENTINELS,
						`${kind} super ${path}: expected all sentinels, found ${JSON.stringify(found)}`
					);
					const o1 = orders.find((o) => o.id === 'o1');
					deepStrictEqual(
						o1.customer,
						{ id: 'c1', name: CUST_NAME, email: CUST_EMAIL },
						`${kind} super ${path} customer`
					);
					deepStrictEqual(o1.notes, [{ id: 'n1', orderId: 'o1', text: NOTE_TEXT }], `${kind} super ${path} notes`);
				}
			});

			test(`${kind} role 3 (read on every table, not super) GET /Order/ default read: both @enumerable relationships present in full`, async () => {
				const r = await send('/Order/', auth.r3, accept);
				strictEqual(r.status, 200, slice(r.buf.toString('utf8')));
				const decoded = decodeBody(kind, r);
				const o1 = findOrders(decoded).find((o) => o.id === 'o1');
				console.log(`${kind} r3 /Order/: bytes=${r.buf.length} decoded=${slice(JSON.stringify(decoded))}`);
				deepStrictEqual(o1?.customer, { id: 'c1', name: CUST_NAME, email: CUST_EMAIL }, `${kind} r3 customer`);
				deepStrictEqual(o1?.notes, [{ id: 'n1', orderId: 'o1', text: NOTE_TEXT }], `${kind} r3 notes`);
			});
			for (const path of [...defaultPaths, explicitPath]) {
				test(`${kind} role 1 (Order only) GET ${path}: both @enumerable relationships left out, rows intact`, async () => {
					const r = await send(path, auth.r1, accept);
					strictEqual(r.status, 200, `${path}: ${slice(r.buf.toString('utf8'))}`);
					const decoded = decodeBody(kind, r);
					const text = JSON.stringify(decoded);
					const orders = findOrders(decoded);
					console.log(`${kind} r1 ${path}: bytes=${r.buf.length} orders=${orders.length} decoded=${slice(text)}`);
					const wildcard = path !== explicitPath;
					if (wildcard) {
						ok(
							orders.some((o) => o.id === 'o1' && o.item === 'widget'),
							`${kind} r1 ${path}: granted row o1/widget missing`
						);
						if (!path.startsWith('/Order/o1'))
							ok(
								orders.some((o) => o.id === 'o2'),
								`${kind} r1 ${path}: granted row o2 missing`
							);
						for (const o of orders) {
							ok(!('customer' in o), `${kind} r1 ${path}: customer key present on ${JSON.stringify(o)}`);
							ok(!('notes' in o), `${kind} r1 ${path}: notes key present on ${JSON.stringify(o)}`);
						}
					} else {
						// explicit sub-select: ids come back, the ungranted relationships do not
						ok(
							text.includes('"o1"') && text.includes('"o2"'),
							`${kind} r1 explicit: ids missing; decoded=${slice(text)}`
						);
						const rows = Array.isArray(decoded) ? decoded : [decoded];
						ok(rows.length >= 2, `${kind} r1 explicit: expected both rows; decoded=${slice(text)}`);
						for (const o of rows)
							ok(
								o && typeof o === 'object' && !('customer' in o) && !('notes' in o),
								`${kind} r1 explicit: ungranted relationship key present on ${JSON.stringify(o)}`
							);
					}
					deepStrictEqual(
						sentinelsIn(r, text, ALL_SENTINELS),
						[],
						`${kind} r1 ${path}: ungranted sentinel present; decoded=${slice(text, 900)}`
					);
				});
				test(`${kind} role 2 (Order + Customer{id,name}) GET ${path}: customer narrowed to id,name; notes left out`, async () => {
					const r = await send(path, auth.r2, accept);
					strictEqual(r.status, 200, `${path}: ${slice(r.buf.toString('utf8'))}`);
					const decoded = decodeBody(kind, r);
					const text = JSON.stringify(decoded);
					const orders = findOrders(decoded);
					console.log(`${kind} r2 ${path}: bytes=${r.buf.length} orders=${orders.length} decoded=${slice(text)}`);
					deepStrictEqual(
						sentinelsIn(r, text, [CUST_EMAIL, NOTE_TEXT]),
						[],
						`${kind} r2 ${path}: ungranted sentinel present; decoded=${slice(text, 900)}`
					);
					ok(
						rawHas(r, CUST_NAME) || text.includes(CUST_NAME),
						`${kind} r2 ${path}: granted customer.name missing (narrowing must keep what the role may read)`
					);
					if (path !== explicitPath) {
						const o1 = orders.find((o) => o.id === 'o1');
						ok(o1 && o1.item === 'widget', `${kind} r2 ${path}: granted row o1/widget missing`);
						deepStrictEqual(
							o1.customer,
							{ id: 'c1', name: CUST_NAME },
							`${kind} r2 ${path}: customer must be narrowed to id,name`
						);
						ok(!('notes' in o1), `${kind} r2 ${path}: notes key present on ${JSON.stringify(o1)}`);
					}
				});
			}
		}

		// ---- CSV: the format where SF-90 showed plain relationships escaping; here the @enumerable form ----
		/** quote-aware CSV line parser (a relationship cell is JSON with commas inside the quotes) */
		const csvLine = (line: string): string[] => {
			const cells: string[] = [];
			let cur = '';
			let inQ = false;
			for (let i = 0; i < line.length; i++) {
				const ch = line[i];
				if (inQ) {
					if (ch === '"' && line[i + 1] === '"') {
						cur += '"';
						i++;
					} else if (ch === '"') inQ = false;
					else cur += ch;
				} else if (ch === '"') inQ = true;
				else if (ch === ',') {
					cells.push(cur);
					cur = '';
				} else cur += ch;
			}
			cells.push(cur);
			return cells;
		};
		const csvRows = (body: string) => body.split('\n').filter(Boolean).map(csvLine);
		test('csv collection default read GET /Order/: the readable-in-full principals (super, role 3) get one header; recorded', async () => {
			const su = await send('/Order/', adminAuth, 'text/csv');
			const r3 = await send('/Order/', auth.r3, 'text/csv');
			const r2 = await send('/Order/', auth.r2, 'text/csv');
			for (const [who, r] of [
				['super', su],
				['r3', r3],
				['r2', r2],
			] as const) {
				strictEqual(r.status, 200, `${who}: ${slice(r.buf.toString('utf8'))}`);
				console.log(
					`csv collection default ${who}: header=${JSON.stringify(csvRows(r.buf.toString('utf8'))[0])} sentinels=${JSON.stringify(sentinelsIn(r, r.buf.toString('utf8'), ALL_SENTINELS))}`
				);
			}
			const [hSu, ...rowsSu] = csvRows(su.buf.toString('utf8'));
			const [hR3] = csvRows(r3.buf.toString('utf8'));
			deepStrictEqual(
				hR3,
				hSu,
				'a non-super principal that reads every table in full gets the same CSV header as the super user'
			);
			ok(
				rowsSu.some((row) => row.includes('o1') && row.includes('widget')),
				`super rows missing; ${slice(su.buf.toString('utf8'))}`
			);
			// observed on f5c1be214 (SQA-153): the collection default read derives its columns from the first row's OWN keys
			// (contentTypes.ts toCsvStream Object.keys(chunk)), so @enumerable relationship columns are absent for these
			// principals while `/Order/o1` (toJSON) and `select(*)` (buildSelectColumns) carry them, and role 2's authorized
			// select lists `customer`. Recorded here; asserted only as role-independence above.
		});
		for (const path of ['/Order/?select(*)', '/Order/o1']) {
			test(`csv CONTROL super GET ${path}: customer and notes columns present with every sentinel`, async () => {
				const r = await send(path, adminAuth, 'text/csv');
				const body = r.buf.toString('utf8');
				console.log(`csv CONTROL super ${path}: status=${r.status} body=${slice(body)}`);
				strictEqual(r.status, 200, body);
				const [header] = csvRows(body);
				ok(
					header.includes('customer') && header.includes('notes'),
					`csv super ${path}: header ${JSON.stringify(header)}`
				);
				deepStrictEqual(sentinelsIn(r, body, ALL_SENTINELS), ALL_SENTINELS, `csv super ${path}: sentinels missing`);
			});
		}
		for (const path of ['/Order/', '/Order/?select(*)', '/Order/o1']) {
			test(`csv role 1 GET ${path}: no customer/notes column, no sentinel, rows intact`, async () => {
				const r = await send(path, auth.r1, 'text/csv');
				const body = r.buf.toString('utf8');
				console.log(`csv r1 ${path}: status=${r.status} body=${slice(body)}`);
				strictEqual(r.status, 200, body);
				const [header, ...rows] = csvRows(body);
				ok(
					!header.includes('customer') && !header.includes('notes'),
					`csv r1 ${path}: header ${JSON.stringify(header)}`
				);
				ok(
					rows.some((row) => row.includes('o1') && row.includes('widget')),
					`csv r1 ${path}: granted row missing; body=${slice(body)}`
				);
				deepStrictEqual(
					sentinelsIn(r, body, ALL_SENTINELS),
					[],
					`csv r1 ${path}: ungranted sentinel present; body=${slice(body)}`
				);
			});
			test(`csv role 2 GET ${path}: customer cell narrowed to id,name; no notes column`, async () => {
				const r = await send(path, auth.r2, 'text/csv');
				const body = r.buf.toString('utf8');
				console.log(`csv r2 ${path}: status=${r.status} body=${slice(body)}`);
				strictEqual(r.status, 200, body);
				const [header, ...rows] = csvRows(body);
				ok(header.includes('customer'), `csv r2 ${path}: customer column missing; header ${JSON.stringify(header)}`);
				ok(!header.includes('notes'), `csv r2 ${path}: notes column present; header ${JSON.stringify(header)}`);
				const ci = header.indexOf('customer');
				const o1 = rows.find((row) => row.includes('o1'));
				ok(o1, `csv r2 ${path}: granted row missing; body=${slice(body)}`);
				deepStrictEqual(
					JSON.parse(o1![ci]),
					{ id: 'c1', name: CUST_NAME },
					`csv r2 ${path}: customer cell must be narrowed to id,name`
				);
				deepStrictEqual(
					sentinelsIn(r, body, [CUST_EMAIL, NOTE_TEXT]),
					[],
					`csv r2 ${path}: ungranted sentinel present; body=${slice(body)}`
				);
			});
		}
	}
);
