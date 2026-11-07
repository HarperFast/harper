/**
 * `@enumerable` relationships are part of a default read, so the related-table read rule
 * (docs/reference/users-and-roles/overview.md, "Reading a @relationship attribute"; harper#3316) has to hold on every
 * response format for the default read as well as for select(*), select(*,name) and an explicit sub-select.
 * Order.customer is a forward (`from`) relationship and Order.notes a one-to-many (`to`) one, both @enumerable.
 * Role 1 reads Order only; role 2 also reads Customer limited to id,name; role 3 reads every table without being a
 * super user. The super-user and role 3 arms are the live positive control: on every format they carry both related
 * records in full. CSV collection default reads derive their columns from the first row's own keys, so they carry no
 * relationship column for a principal that reads everything; the record URL and select(*) do.
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
const ROLE1 = 'enumfmt_orders_only';
const USER1 = 'enumfmt_orders_user';
const ROLE2 = 'enumfmt_orders_custname';
const USER2 = 'enumfmt_custname_user';
const ROLE3 = 'enumfmt_read_all';
const USER3 = 'enumfmt_read_all_user';
const PASS = `enumfmt-${Math.random().toString(36).slice(2)}`;
const CUST_NAME = 'SENTINEL-CUSTNAME-7f3a';
const CUST_EMAIL = 'SENTINEL-EMAIL-9c1d@example.test';
const NOTE_TEXT = 'SENTINEL-NOTE-4b8e';
const ALL_SENTINELS = [CUST_NAME, CUST_EMAIL, NOTE_TEXT];
const REQUEST_TIMEOUT_MS = 15_000;

type Kind = 'json' | 'cbor' | 'msgpack' | 'ndjson';
interface R {
	status: number;
	buf: Buffer;
}
const slice = (s: string, n = 700) => (s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s);

suite(
	'@enumerable relationships follow related-table permissions on every response format',
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
					res.on('end', () => done({ status: res.statusCode!, buf: Buffer.concat(chunks) }));
					res.on('error', fail);
				});
				req.setTimeout(REQUEST_TIMEOUT_MS, () =>
					req.destroy(new Error(`GET ${path} as ${accept}: no response within ${REQUEST_TIMEOUT_MS} ms`))
				);
				req.on('error', fail);
				req.end();
			});

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
		const findOrders = (value: unknown, out: any[] = []): any[] => {
			if (Array.isArray(value)) for (const v of value) findOrders(v, out);
			else if (value && typeof value === 'object') {
				if ('item' in (value as any)) out.push(value);
				else for (const v of Object.values(value as any)) findOrders(v, out);
			}
			return out;
		};
		const rows = (decoded: unknown): any[] => (Array.isArray(decoded) ? decoded : [decoded]);
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
			const readAll = { read: true, insert: false, update: false, delete: false, attribute_permissions: [] };
			const custName = {
				...readAll,
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
			await mk(ROLE1, USER1, { Order: readAll });
			await mk(ROLE2, USER2, { Order: readAll, Customer: custName });
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

		test('preconditions: 401 without credentials; role 1 denied Customer and Note directly; role 2 denied Note', async () => {
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
		const FULL_CUSTOMER = { id: 'c1', name: CUST_NAME, email: CUST_EMAIL };
		const FULL_NOTES = [{ id: 'n1', orderId: 'o1', text: NOTE_TEXT }];

		for (const [kind, accept] of formats) {
			test(`${kind} control: super user default read, select(*) and select(*,customer) carry both related records in full`, async () => {
				for (const path of defaultPaths) {
					const r = await send(path, adminAuth, accept);
					strictEqual(r.status, 200, `${path}: ${slice(r.buf.toString('utf8'))}`);
					const decoded = decodeBody(kind, r);
					const orders = findOrders(decoded);
					const o1 = orders.find((o) => o.id === 'o1');
					ok(o1, `${kind} super ${path}: o1 missing; decoded=${slice(JSON.stringify(decoded))}`);
					deepStrictEqual(o1.customer, FULL_CUSTOMER, `${kind} super ${path} customer`);
					deepStrictEqual(o1.notes, FULL_NOTES, `${kind} super ${path} notes`);
					deepStrictEqual(
						sentinelsIn(r, JSON.stringify(decoded), ALL_SENTINELS),
						ALL_SENTINELS,
						`${kind} super ${path}`
					);
				}
			});
			test(`${kind} control: super user explicit sub-select carries every related value`, async () => {
				const r = await send(explicitPath, adminAuth, accept);
				strictEqual(r.status, 200, slice(r.buf.toString('utf8')));
				const text = JSON.stringify(decodeBody(kind, r));
				deepStrictEqual(sentinelsIn(r, text, ALL_SENTINELS), ALL_SENTINELS, `${kind} super explicit: ${slice(text)}`);
			});
			test(`${kind} role 3 (read on every table, not super) default read carries both related records in full`, async () => {
				const r = await send('/Order/', auth.r3, accept);
				strictEqual(r.status, 200, slice(r.buf.toString('utf8')));
				const decoded = decodeBody(kind, r);
				const o1 = findOrders(decoded).find((o) => o.id === 'o1');
				deepStrictEqual(o1?.customer, FULL_CUSTOMER, `${kind} r3 customer; decoded=${slice(JSON.stringify(decoded))}`);
				deepStrictEqual(o1?.notes, FULL_NOTES, `${kind} r3 notes`);
			});

			for (const path of [...defaultPaths, explicitPath]) {
				const explicit = path === explicitPath;
				test(`${kind} role 1 (Order only) GET ${path}: both relationships left out, rows intact`, async () => {
					const r = await send(path, auth.r1, accept);
					strictEqual(r.status, 200, `${path}: ${slice(r.buf.toString('utf8'))}`);
					const decoded = decodeBody(kind, r);
					const text = JSON.stringify(decoded);
					const orders = explicit ? rows(decoded) : findOrders(decoded);
					ok(
						orders.some((o) => o.id === 'o1' && (explicit || o.item === 'widget')),
						`${kind} r1 ${path}: granted row o1 missing; decoded=${slice(text)}`
					);
					if (!path.startsWith('/Order/o1'))
						ok(
							orders.some((o) => o.id === 'o2'),
							`${kind} r1 ${path}: granted row o2 missing`
						);
					for (const o of orders) {
						ok(!('customer' in o), `${kind} r1 ${path}: customer present on ${JSON.stringify(o)}`);
						ok(!('notes' in o), `${kind} r1 ${path}: notes present on ${JSON.stringify(o)}`);
					}
					deepStrictEqual(
						sentinelsIn(r, text, ALL_SENTINELS),
						[],
						`${kind} r1 ${path}: ungranted value present; decoded=${slice(text, 900)}`
					);
				});
				test(`${kind} role 2 (Order + Customer{id,name}) GET ${path}: customer narrowed, notes left out`, async () => {
					const r = await send(path, auth.r2, accept);
					strictEqual(r.status, 200, `${path}: ${slice(r.buf.toString('utf8'))}`);
					const decoded = decodeBody(kind, r);
					const text = JSON.stringify(decoded);
					deepStrictEqual(
						sentinelsIn(r, text, [CUST_EMAIL, NOTE_TEXT]),
						[],
						`${kind} r2 ${path}: ungranted value present; decoded=${slice(text, 900)}`
					);
					const orders = explicit ? rows(decoded) : findOrders(decoded);
					const o1 = orders.find((o) => o.id === 'o1');
					ok(
						o1 && (explicit || o1.item === 'widget'),
						`${kind} r2 ${path}: granted row o1 missing; decoded=${slice(text)}`
					);
					// the explicit sub-select names customer{name,email}, so the narrowed record carries only name
					deepStrictEqual(
						o1.customer,
						explicit ? { name: CUST_NAME } : { id: 'c1', name: CUST_NAME },
						`${kind} r2 ${path}: customer must be narrowed`
					);
					ok(!('notes' in o1), `${kind} r2 ${path}: notes present on ${JSON.stringify(o1)}`);
				});
			}
		}

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
		const csvCell = (header: string[], row: string[], column: string) => row[header.indexOf(column)];

		test('csv collection default read: super user and role 3 get the same header, and neither carries a related value', async () => {
			const su = await send('/Order/', adminAuth, 'text/csv');
			const r3 = await send('/Order/', auth.r3, 'text/csv');
			strictEqual(su.status, 200, slice(su.buf.toString('utf8')));
			strictEqual(r3.status, 200, slice(r3.buf.toString('utf8')));
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
		});
		const csvPaths = ['/Order/?select(*)', '/Order/o1', '/Order/o1?select(*)', '/Order/?select(*,customer)'];
		for (const path of csvPaths) {
			test(`csv control: super user GET ${path} carries customer and notes columns with every related value`, async () => {
				const r = await send(path, adminAuth, 'text/csv');
				const body = r.buf.toString('utf8');
				strictEqual(r.status, 200, body);
				const [header] = csvRows(body);
				ok(
					header.includes('customer') && header.includes('notes'),
					`csv super ${path}: header ${JSON.stringify(header)}`
				);
				deepStrictEqual(sentinelsIn(r, body, ALL_SENTINELS), ALL_SENTINELS, `csv super ${path}: ${slice(body)}`);
			});
		}
		test(`csv control: super user GET ${explicitPath} carries every related value`, async () => {
			const r = await send(explicitPath, adminAuth, 'text/csv');
			const body = r.buf.toString('utf8');
			strictEqual(r.status, 200, body);
			deepStrictEqual(sentinelsIn(r, body, ALL_SENTINELS), ALL_SENTINELS, `csv super explicit: ${slice(body)}`);
		});
		for (const path of ['/Order/', ...csvPaths, explicitPath]) {
			const explicit = path === explicitPath;
			test(`csv role 1 GET ${path}: no customer or notes column, no related value, rows intact`, async () => {
				const r = await send(path, auth.r1, 'text/csv');
				const body = r.buf.toString('utf8');
				strictEqual(r.status, 200, body);
				const [header, ...dataRows] = csvRows(body);
				ok(
					!header.includes('customer') && !header.includes('notes'),
					`csv r1 ${path}: header ${JSON.stringify(header)}`
				);
				ok(
					dataRows.some((row) => row.includes('o1') && (explicit || row.includes('widget'))),
					`csv r1 ${path}: granted row missing; ${slice(body)}`
				);
				deepStrictEqual(
					sentinelsIn(r, body, ALL_SENTINELS),
					[],
					`csv r1 ${path}: ungranted value present; ${slice(body)}`
				);
			});
			test(`csv role 2 GET ${path}: customer cell narrowed, no notes column`, async () => {
				const r = await send(path, auth.r2, 'text/csv');
				const body = r.buf.toString('utf8');
				strictEqual(r.status, 200, body);
				const [header, ...dataRows] = csvRows(body);
				ok(header.includes('customer'), `csv r2 ${path}: customer column missing; header ${JSON.stringify(header)}`);
				ok(!header.includes('notes'), `csv r2 ${path}: notes column present; header ${JSON.stringify(header)}`);
				const o1 = dataRows.find((row) => row.includes('o1'));
				ok(o1, `csv r2 ${path}: granted row missing; ${slice(body)}`);
				deepStrictEqual(
					JSON.parse(csvCell(header, o1!, 'customer')),
					explicit ? { name: CUST_NAME } : { id: 'c1', name: CUST_NAME },
					`csv r2 ${path}: customer cell must be narrowed`
				);
				deepStrictEqual(
					sentinelsIn(r, body, [CUST_EMAIL, NOTE_TEXT]),
					[],
					`csv r2 ${path}: ungranted value present; ${slice(body)}`
				);
			});
		}
	}
);
