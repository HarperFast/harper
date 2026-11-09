/**
 * The related-table read rule (docs/reference/users-and-roles/overview.md, "Reading a @relationship attribute";
 * harper#3316) on the response paths the JSON anchors do not cover: CBOR, MessagePack and NDJSON for select(*) and an
 * explicit sub-select, and the export_local job with get_attributes ["*"] as csv and json. Role 1 reads Order only;
 * role 2 also reads Customer limited to id,name; nothing reads Note. REST select(*) leaves every relationship out for
 * everyone, so the super-user explicit sub-select is the detection-live control on HTTP; in an export a non-super
 * get_attributes ["*"] expands the relationships the role may read, so role 2's narrowed customer column is the
 * detection-live control there (the super user's "*" exports own attributes only).
 *
 * Run:
 *   npm run build && npm run test:integration -- "integrationTests/security/relationship-formats-related-read.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual, fail } from 'node:assert';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { decode as cborDecode, decodeMultiple as cborDecodeMultiple } from 'cbor-x';
import { unpack as msgpackUnpack, unpackMultiple as msgpackUnpackMultiple } from 'msgpackr';
// @ts-expect-error utils/client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/relationship-formats-related-read');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';
const ROLE1 = 'relfmt_orders_only';
const USER1 = 'relfmt_orders_user';
const ROLE2 = 'relfmt_orders_custname';
const USER2 = 'relfmt_custname_user';
const XROLE1 = 'relfmt_x_orders_only';
const XUSER1 = 'relfmt_x_orders_user';
const XROLE2 = 'relfmt_x_orders_custname';
const XUSER2 = 'relfmt_x_custname_user';
const PASS = `relfmt-${Math.random().toString(36).slice(2)}`;
const CUST_NAME = 'SENTINEL-CUSTNAME-7f3a';
const CUST_EMAIL = 'SENTINEL-EMAIL-9c1d@example.test';
const NOTE_TEXT = 'SENTINEL-NOTE-4b8e';
const ALL_SENTINELS = [CUST_NAME, CUST_EMAIL, NOTE_TEXT];
const REQUEST_TIMEOUT_MS = 15_000;
const JOB_TIMEOUT_MS = 30_000;

type Kind = 'cbor' | 'msgpack' | 'ndjson';
interface R {
	status: number;
	buf: Buffer;
}
const slice = (s: string, n = 700) => (s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s);

suite(
	'related-table read permission on CBOR / MessagePack / NDJSON / export_local',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let host: string, port: number, adminAuth: string;
		const auth: Record<string, string> = {};
		let exportRoot: string;
		const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

		const send = (path: string, authz: string | null, accept: string): Promise<R> =>
			new Promise((done, failed) => {
				const headers: Record<string, string> = { Accept: accept, Connection: 'close' };
				if (authz) headers.Authorization = authz;
				const req = httpRequest({ host, port, method: 'GET', path, agent: false, headers }, (res) => {
					const chunks: Buffer[] = [];
					res.on('data', (c) => chunks.push(Buffer.from(c)));
					res.on('end', () => done({ status: res.statusCode!, buf: Buffer.concat(chunks) }));
					res.on('error', failed);
				});
				req.setTimeout(REQUEST_TIMEOUT_MS, () =>
					req.destroy(new Error(`GET ${path} as ${accept}: no response within ${REQUEST_TIMEOUT_MS} ms`))
				);
				req.on('error', failed);
				req.end();
			});
		const op = async (body: Record<string, unknown>, authz: string) => {
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Authorization': authz, 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const text = await response.text();
			let parsed: any = text;
			try {
				parsed = JSON.parse(text);
			} catch {}
			return { status: response.status, text, body: parsed };
		};

		const decodeBody = (kind: Kind, r: R): unknown => {
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
		const rows = (decoded: unknown): any[] => (Array.isArray(decoded) ? decoded : [decoded]);
		const rawHas = (r: R, s: string) => r.buf.includes(Buffer.from(s, 'utf8'));
		const sentinelsIn = (r: R, decodedText: string, sentinels: readonly string[]) =>
			sentinels.filter((s) => decodedText.includes(s) || rawHas(r, s));

		before(async () => {
			exportRoot = mkdtempSync(join(tmpdir(), 'relfmt-export-'));
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
			auth.x1 = basic(XUSER1, PASS);
			auth.x2 = basic(XUSER2, PASS);
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
				...orderOnly,
				attribute_permissions: [
					{ attribute_name: 'id', read: true, insert: false, update: false, delete: false },
					{ attribute_name: 'name', read: true, insert: false, update: false, delete: false },
				],
			};
			const exportOps = ['export_local', 'get_job', 'search_by_value', 'search_by_conditions'];
			const mk = async (role: string, user: string, tables: any, operations?: string[]) => {
				const permission: any = { super_user: false, data: { tables } };
				if (operations) permission.operations = operations;
				await api.req().send({ operation: 'add_role', role, permission }).expect(200);
				await api.req().send({ operation: 'add_user', username: user, password: PASS, role, active: true }).expect(200);
			};
			await mk(ROLE1, USER1, { Order: orderOnly });
			await mk(ROLE2, USER2, { Order: orderOnly, Customer: custName });
			await mk(XROLE1, XUSER1, { Order: orderOnly }, exportOps);
			await mk(XROLE2, XUSER2, { Order: orderOnly, Customer: custName }, exportOps);
			let ready = 0;
			for (let i = 0; i < 60 && ready !== 200; i++) {
				ready = (await send('/Order/o1', adminAuth, 'application/json')).status;
				if (ready !== 200) await new Promise((x) => setTimeout(x, 500));
			}
			strictEqual(ready, 200, 'readiness: admin GET /Order/o1 answers 200');
		});
		after(async () => {
			await teardownHarper(ctx);
			if (exportRoot) rmSync(exportRoot, { recursive: true, force: true });
		});

		test('preconditions: 401 without credentials; role 1 denied Customer and Note directly; JSON select(*) carries no related value', async () => {
			strictEqual((await send('/Order/o1', null, 'application/json')).status, 401);
			strictEqual((await send('/Customer/c1', auth.r1, 'application/json')).status, 403);
			strictEqual((await send('/Note/n1', auth.r1, 'application/json')).status, 403);
			strictEqual((await send('/Order/o1', auth.r1, 'application/json')).status, 200);
			const j1 = await send('/Order/?select(*)', auth.r1, 'application/json');
			const j2 = await send('/Order/?select(*)', auth.r2, 'application/json');
			strictEqual(j1.status, 200);
			strictEqual(j2.status, 200);
			deepStrictEqual(
				sentinelsIn(j1, j1.buf.toString(), ALL_SENTINELS),
				[],
				`role 1 JSON reference: ${slice(j1.buf.toString())}`
			);
			deepStrictEqual(
				sentinelsIn(j2, j2.buf.toString(), [CUST_EMAIL, NOTE_TEXT]),
				[],
				`role 2 JSON reference: ${slice(j2.buf.toString())}`
			);
		});

		const formats: [Kind, string][] = [
			['cbor', 'application/cbor'],
			['msgpack', 'application/x-msgpack'],
			['ndjson', 'application/x-ndjson'],
		];
		const wildcardPaths = ['/Order/?select(*)', '/Order/o1?select(*)'];
		const explicitPaths = [
			'/Order/?select(id,customer{name,email},notes{text})',
			'/Order/o1?select(id,customer{name,email},notes{text})',
		];
		for (const [kind, accept] of formats) {
			test(`${kind} control: super user select(*) decodes and leaves every relationship out`, async () => {
				for (const path of wildcardPaths) {
					const r = await send(path, adminAuth, accept);
					strictEqual(r.status, 200, `${path}: ${slice(r.buf.toString('utf8'))}`);
					const decoded = decodeBody(kind, r);
					const o1 = rows(decoded).find((o) => o?.id === 'o1');
					ok(o1 && o1.item === 'widget', `${kind} super ${path}: o1 missing; ${slice(JSON.stringify(decoded))}`);
					deepStrictEqual(
						sentinelsIn(r, JSON.stringify(decoded), ALL_SENTINELS),
						[],
						`${kind} super ${path}: select(*) expanded a relationship`
					);
				}
			});
			test(`${kind} control: super user explicit sub-select carries every related value (detection live on this path)`, async () => {
				for (const path of explicitPaths) {
					const r = await send(path, adminAuth, accept);
					strictEqual(r.status, 200, `${path}: ${slice(r.buf.toString('utf8'))}`);
					const text = JSON.stringify(decodeBody(kind, r));
					deepStrictEqual(sentinelsIn(r, text, ALL_SENTINELS), ALL_SENTINELS, `${kind} super ${path}: ${slice(text)}`);
				}
			});
			for (const path of [...wildcardPaths, ...explicitPaths]) {
				const explicit = explicitPaths.includes(path);
				const record = path.startsWith('/Order/o1');
				test(`${kind} role 1 (Order only) GET ${path}: granted rows only, no related value`, async () => {
					const r = await send(path, auth.r1, accept);
					strictEqual(r.status, 200, `${path}: ${slice(r.buf.toString('utf8'))}`);
					const decoded = decodeBody(kind, r);
					const text = JSON.stringify(decoded);
					const all = rows(decoded);
					ok(
						all.some((o) => o?.id === 'o1' && (explicit || o.item === 'widget')),
						`${kind} r1 ${path}: o1 missing; ${slice(text, 900)}`
					);
					if (!record)
						ok(
							all.some((o) => o?.id === 'o2'),
							`${kind} r1 ${path}: o2 missing; ${slice(text, 900)}`
						);
					for (const o of all)
						ok(
							!('customer' in o) && !('notes' in o),
							`${kind} r1 ${path}: relationship key present on ${JSON.stringify(o)}`
						);
					deepStrictEqual(
						sentinelsIn(r, text, ALL_SENTINELS),
						[],
						`${kind} r1 ${path}: ungranted value present; ${slice(text, 900)}`
					);
				});
				test(`${kind} role 2 (Order + Customer{id,name}) GET ${path}: customer narrowed to name on the explicit select, nothing else`, async () => {
					const r = await send(path, auth.r2, accept);
					strictEqual(r.status, 200, `${path}: ${slice(r.buf.toString('utf8'))}`);
					const decoded = decodeBody(kind, r);
					const text = JSON.stringify(decoded);
					deepStrictEqual(
						sentinelsIn(r, text, [CUST_EMAIL, NOTE_TEXT]),
						[],
						`${kind} r2 ${path}: ungranted value present; ${slice(text, 900)}`
					);
					const o1 = rows(decoded).find((o) => o?.id === 'o1');
					ok(o1 && (explicit || o1.item === 'widget'), `${kind} r2 ${path}: o1 missing; ${slice(text, 900)}`);
					if (explicit)
						deepStrictEqual(o1.customer, { name: CUST_NAME }, `${kind} r2 ${path}: customer must be narrowed to name`);
					else ok(!('customer' in o1), `${kind} r2 ${path}: select(*) expanded customer on ${JSON.stringify(o1)}`);
					ok(!('notes' in o1), `${kind} r2 ${path}: notes present on ${JSON.stringify(o1)}`);
				});
			}
		}

		const searchByValue = (extra: Record<string, unknown> = {}) => ({
			operation: 'search_by_value',
			schema: 'data',
			table: 'Order',
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['*'],
			...extra,
		});
		const searchByConditions = () => ({
			operation: 'search_by_conditions',
			schema: 'data',
			table: 'Order',
			get_attributes: ['*'],
			conditions: [{ search_attribute: 'id', search_type: 'starts_with', search_value: 'o' }],
		});
		let seq = 0;
		/** starts an export as `authz`, polls get_job as the same principal, returns the exported files' text */
		async function runExport(
			authz: string,
			format: 'csv' | 'json',
			search_operation: Record<string, unknown>,
			tag: string
		) {
			const dir = mkdtempSync(join(exportRoot, `${tag}-`));
			const start = await op(
				{ operation: 'export_local', format, path: dir, filename: `out${seq++}`, search_operation },
				authz
			);
			strictEqual(start.status, 200, `export_local must start: ${start.status} ${start.text}`);
			const jobId = start.body?.job_id;
			ok(jobId, start.text);
			const deadline = Date.now() + JOB_TIMEOUT_MS;
			let job: any;
			while (Date.now() < deadline) {
				const r = await op({ operation: 'get_job', id: jobId }, authz);
				strictEqual(r.status, 200, `get_job as the submitter: ${r.status} ${r.text}`);
				job = Array.isArray(r.body) ? r.body[0] : r.body;
				if (job?.status === 'COMPLETE' || job?.status === 'ERROR') break;
				await new Promise((x) => setTimeout(x, 200));
			}
			if (job?.status !== 'COMPLETE')
				fail(`export job ${jobId} did not complete within ${JOB_TIMEOUT_MS} ms: ${JSON.stringify(job)}`);
			const files: Record<string, string> = {};
			for (const f of readdirSync(dir)) files[f] = readFileSync(join(dir, f), 'utf8');
			return Object.values(files).join('\n');
		}

		test('roles without an operations grant are refused export_local', async () => {
			for (const who of ['r1', 'r2']) {
				const r = await op(
					{
						operation: 'export_local',
						format: 'csv',
						path: exportRoot,
						filename: `refused-${who}`,
						search_operation: searchByValue(),
					},
					auth[who]
				);
				ok(r.status === 403 || r.status === 401, `${who}: expected refusal, got ${r.status} ${r.text}`);
			}
		});

		for (const format of ['csv', 'json'] as const) {
			for (const [name, mkSearch] of [
				['search_by_value', searchByValue],
				['search_by_conditions', searchByConditions],
			] as const) {
				test(`export ${format} ${name} control: super user get_attributes ['*'] exports own attributes only`, async () => {
					const all = await runExport(adminAuth, format, mkSearch(), `ctlA-${format}`);
					ok(
						all.includes('o1') && all.includes('o2') && all.includes('widget'),
						`granted rows missing: ${slice(all, 900)}`
					);
					ok(
						!ALL_SENTINELS.some((s) => all.includes(s)),
						`super "*" export expanded a relationship: ${slice(all, 900)}`
					);
				});
				test(`export ${format} ${name} control: super user explicit ['id','customer','notes'] carries every related value (detection live)`, async () => {
					const all = await runExport(
						adminAuth,
						format,
						{ ...mkSearch(), get_attributes: ['id', 'customer', 'notes'] },
						`ctlB-${format}`
					);
					ok(
						ALL_SENTINELS.every((s) => all.includes(s)),
						`super explicit export should carry every related value: ${slice(all, 900)}`
					);
				});
				test(`export ${format} ${name} role 1: file carries the granted rows and no related value`, async () => {
					const all = await runExport(auth.x1, format, mkSearch(), `x1-${format}`);
					ok(
						all.includes('o1') && all.includes('o2') && all.includes('widget'),
						`granted rows missing: ${slice(all, 900)}`
					);
					deepStrictEqual(
						ALL_SENTINELS.filter((s) => all.includes(s)),
						[],
						`export ${format} ${name} role 1: ungranted value present: ${slice(all, 900)}`
					);
				});
				test(`export ${format} ${name} role 2: "*" expands customer narrowed to id,name and nothing from Note`, async () => {
					const all = await runExport(auth.x2, format, mkSearch(), `x2-${format}`);
					ok(
						all.includes('o1') && all.includes('o2') && all.includes('widget'),
						`granted rows missing: ${slice(all, 900)}`
					);
					ok(
						all.includes(CUST_NAME),
						`export ${format} ${name} role 2: a non-super "*" expands the readable relationship: ${slice(all, 900)}`
					);
					deepStrictEqual(
						[CUST_EMAIL, NOTE_TEXT].filter((s) => all.includes(s)),
						[],
						`export ${format} ${name} role 2: ungranted value present: ${slice(all, 900)}`
					);
				});
			}
		}
	}
);
