/**
 * Related-table read permissions on the non-JSON response formats and the export job (anchors harper#3316,
 * docs/reference/users-and-roles/overview.md "Reading a @relationship attribute"; originated as qa-explorer SQA-145 / SP-108).
 *
 * SQA-145: the documented table read permission contract (`users-and-roles/overview.md`: a table not in the
 * role's permission set is inaccessible) must hold on every response format. Sibling paths of the SQA-144
 * CSV defect: CBOR, MessagePack, NDJSON on GET /Order/?select(*) and the export_local job with
 * get_attributes ['*'] (csv and json). Role 1 = Order only; role 2 = Order + Customer{id,name}; nothing on Note.
 * Every arm has a super-user control (detection is live) and the JSON select(*) is the reference projection.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { decode as cborDecode, decodeMultiple as cborDecodeMultiple } from 'cbor-x';
import { unpack as msgpackUnpack, unpackMultiple as msgpackUnpackMultiple } from 'msgpackr';
// @ts-expect-error utils/client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/relationship-formats-related-read');
const SCRATCH_ROOT = tmpdir();
const ROLE1 = 'sqa145_orders_only';
const USER1 = 'sqa145_orders_user';
const ROLE2 = 'sqa145_orders_custname';
const USER2 = 'sqa145_custname_user';
// same data grants as role 1/2 plus the operations list an export_local job needs
const XROLE1 = 'sqa145_x_orders_only';
const XUSER1 = 'sqa145_x_orders_user';
const XROLE2 = 'sqa145_x_orders_custname';
const XUSER2 = 'sqa145_x_custname_user';
const PASS = `sqa145-${Math.random().toString(36).slice(2)}`;
const CUST_NAME = 'SENTINEL-CUSTNAME-7f3a';
const CUST_EMAIL = 'SENTINEL-EMAIL-9c1d@example.test';
const NOTE_TEXT = 'SENTINEL-NOTE-4b8e';
const ALL_SENTINELS = [CUST_NAME, CUST_EMAIL, NOTE_TEXT];

interface R {
	status: number;
	buf: Buffer;
	ct: string;
}
const slice = (s: string, n = 700) => (s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s);

suite(
	'SQA-145 related-table read permission on CBOR / MessagePack / NDJSON / export_local',
	(ctx: ContextWithHarper) => {
		let host: string, port: number, adminAuth: string;
		const auth: Record<string, string> = {};
		let exportRoot: string;
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
		const op = async (body: Record<string, unknown>, authz: string) => {
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Authorization': authz, 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(45_000),
			});
			const text = await response.text();
			let body2: any = text;
			try {
				body2 = JSON.parse(text);
			} catch {}
			return { status: response.status, text, body: body2 };
		};

		/** decode per format; returns the searchable text plus a raw-bytes (latin1/utf8) view */
		const decodeBody = (kind: 'cbor' | 'msgpack' | 'ndjson', r: R): { text: string; decodeError?: string } => {
			try {
				if (kind === 'cbor') {
					// a streamed collection may be an indefinite array, or concatenated items
					try {
						return { text: JSON.stringify(cborDecode(r.buf)) };
					} catch {
						return { text: JSON.stringify(cborDecodeMultiple(r.buf)) };
					}
				}
				if (kind === 'msgpack') {
					try {
						return { text: JSON.stringify(msgpackUnpack(r.buf)) };
					} catch {
						return { text: JSON.stringify(msgpackUnpackMultiple(r.buf)) };
					}
				}
				return {
					text: JSON.stringify(
						r.buf
							.toString('utf8')
							.split('\n')
							.filter(Boolean)
							.map((l) => JSON.parse(l))
					),
				};
			} catch (e: any) {
				return { text: '', decodeError: String(e?.message ?? e) };
			}
		};
		const rawHas = (r: R, s: string) => r.buf.includes(Buffer.from(s, 'utf8'));
		const leaks = (kind: 'cbor' | 'msgpack' | 'ndjson', r: R, sentinels: string[]) => {
			const { text, decodeError } = decodeBody(kind, r);
			return {
				decodeError,
				decoded: text,
				found: sentinels.filter((s) => text.includes(s) || rawHas(r, s)),
			};
		};

		before(async () => {
			mkdirSync(SCRATCH_ROOT, { recursive: true });
			exportRoot = mkdtempSync(join(SCRATCH_ROOT, 'sqa145-export-'));
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
				read: true,
				insert: false,
				update: false,
				delete: false,
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

		test('P0 preconditions: 401 without credentials; role 1 denied Customer/Note directly; JSON select(*) reference carries no sentinels', async () => {
			strictEqual((await send('/Order/o1', null, 'application/json')).status, 401);
			strictEqual((await send('/Customer/c1', auth.r1, 'application/json')).status, 403);
			strictEqual((await send('/Note/n1', auth.r1, 'application/json')).status, 403);
			strictEqual((await send('/Order/o1', auth.r1, 'application/json')).status, 200);
			const j1 = await send('/Order/?select(*)', auth.r1, 'application/json');
			const j2 = await send('/Order/?select(*)', auth.r2, 'application/json');
			console.log('P0 role1 json:', j1.status, slice(j1.buf.toString()));
			console.log('P0 role2 json:', j2.status, slice(j2.buf.toString()));
			strictEqual(j1.status, 200);
			strictEqual(j2.status, 200);
			for (const s of ALL_SENTINELS) ok(!j1.buf.toString().includes(s), `role1 JSON reference leaks ${s}`);
			ok(
				!j2.buf.toString().includes(CUST_EMAIL) && !j2.buf.toString().includes(NOTE_TEXT),
				'role2 JSON reference leaks'
			);
		});

		const formats = [
			['cbor', 'application/cbor'],
			['msgpack', 'application/x-msgpack'],
			['ndjson', 'application/x-ndjson'],
		] as const;
		for (const [kind, accept] of formats) {
			test(`${kind} control A: super user select(*) is what the path serializes by default (recorded; JSON is the reference)`, async () => {
				for (const path of ['/Order/?select(*)', '/Order/o1?select(*)']) {
					const r = await send(path, adminAuth, accept);
					const l = leaks(kind, r, ALL_SENTINELS);
					console.log(
						`${kind} CONTROL-A super ${path}: status=${r.status} ct=${r.ct} bytes=${r.buf.length} found=${JSON.stringify(l.found)} decodeError=${l.decodeError} decoded=${slice(l.decoded)}`
					);
					strictEqual(r.status, 200);
					ok(!l.decodeError, `${kind} decoder threw: ${l.decodeError}`);
				}
			});
			test(`${kind} control B: super user explicit related select DOES carry the sentinels (detection live on this path)`, async () => {
				for (const path of [
					`/Order/?select(id,customer{name,email},notes{text})`,
					`/Order/o1?select(id,customer{name,email},notes{text})`,
				]) {
					const r = await send(path, adminAuth, accept);
					const l = leaks(kind, r, ALL_SENTINELS);
					console.log(
						`${kind} CONTROL-B super ${path}: status=${r.status} bytes=${r.buf.length} found=${JSON.stringify(l.found)} decodeError=${l.decodeError} decoded=${slice(l.decoded)}`
					);
					strictEqual(r.status, 200);
					ok(!l.decodeError, `${kind} decoder threw: ${l.decodeError}`);
					ok(
						l.found.length === ALL_SENTINELS.length,
						`${kind} control B: expected all sentinels on ${path}; found ${JSON.stringify(l.found)}`
					);
				}
			});
			for (const [label, who, sentinels] of [
				['role 1 (Order only)', 'r1', ALL_SENTINELS],
				['role 2 (Order + Customer{id,name})', 'r2', [CUST_EMAIL, NOTE_TEXT]],
			] as const) {
				for (const path of [
					'/Order/?select(*)',
					'/Order/o1?select(*)',
					'/Order/?select(id,customer{name,email},notes{text})',
				]) {
					test(`${kind} ${label} GET ${path}: no ungranted sentinel`, async () => {
						const r = await send(path, auth[who], accept);
						const l = leaks(kind, r, sentinels as string[]);
						console.log(
							`${kind} ${who} ${path}: status=${r.status} ct=${r.ct} bytes=${r.buf.length} found=${JSON.stringify(l.found)} decodeError=${l.decodeError}`
						);
						console.log(`${kind} ${who} ${path} decoded:`, slice(l.decoded));
						strictEqual(r.status, 200, r.buf.toString('utf8').slice(0, 300));
						ok(!l.decodeError, `${kind} decoder threw: ${l.decodeError}`);
						// the granted rows must be present, so an empty body or `[]` cannot pass this arm
						const text = typeof l.decoded === 'string' ? l.decoded : JSON.stringify(l.decoded);
						ok(
							text.includes('"o1"'),
							`${kind} ${who} ${path}: granted Order row o1 missing; decoded=${slice(l.decoded, 900)}`
						);
						if (path.endsWith('select(*)'))
							ok(text.includes('"widget"'), `${kind} ${who} ${path}: granted attribute item missing`);
						if (!path.startsWith('/Order/o1'))
							ok(text.includes('"o2"'), `${kind} ${who} ${path}: granted Order row o2 missing`);
						ok(
							l.found.length === 0,
							`${kind} ${who} ${path} leaked ${JSON.stringify(l.found)}; decoded=${slice(l.decoded, 900)}`
						);
					});
				}
			}
		}

		// ---- export_local ----
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
			if (start.status !== 200) return { start, job: undefined as any, files: {} as Record<string, string> };
			const jobId = start.body?.job_id;
			ok(jobId, start.text);
			let job: any;
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				const r = await op({ operation: 'get_job', id: jobId }, adminAuth);
				job = Array.isArray(r.body) ? r.body[0] : r.body;
				if (job?.status === 'COMPLETE' || job?.status === 'ERROR') break;
				await new Promise((x) => setTimeout(x, 200));
			}
			const files: Record<string, string> = {};
			for (const f of readdirSync(dir)) files[f] = readFileSync(join(dir, f), 'utf8');
			return { start, job, files };
		}

		test('X0 role 1 / role 2 WITHOUT an operations grant are refused export_local (record status)', async () => {
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
				console.log(`X0 ${who} export_local (no operations grant): status=${r.status} body=${r.text}`);
				ok(r.status === 403 || r.status === 401, `expected refusal, got ${r.status} ${r.text}`);
			}
		});

		for (const format of ['csv', 'json'] as const) {
			for (const [name, mkSearch] of [
				['search_by_value', searchByValue],
				['search_by_conditions', searchByConditions],
			] as const) {
				test(`export ${format} ${name} control A: super user get_attributes ['*'] (recorded, no assertion on sentinels)`, async () => {
					const { start, job, files } = await runExport(adminAuth, format, mkSearch(), `ctlA-${format}`);
					console.log(
						`export ${format} ${name} CONTROL-A super *: start=${start.status} status=${job?.status} files=${slice(JSON.stringify(files), 900)}`
					);
					strictEqual(job.status, 'COMPLETE', JSON.stringify(job));
				});
				test(`export ${format} ${name} control B: super user explicit ['id','customer','notes'] DOES carry sentinels (detection live)`, async () => {
					const { start, job, files } = await runExport(
						adminAuth,
						format,
						{ ...mkSearch(), get_attributes: ['id', 'customer', 'notes'] },
						`ctlB-${format}`
					);
					console.log(
						`export ${format} ${name} CONTROL-B super: start=${start.status} job=${JSON.stringify(job)?.slice(0, 300)} files=${slice(JSON.stringify(files), 900)}`
					);
					strictEqual(start.status, 200, start.text);
					strictEqual(job.status, 'COMPLETE', JSON.stringify(job));
					const all = Object.values(files).join('\n');
					ok(
						ALL_SENTINELS.every((s) => all.includes(s)),
						`export control: super-user export should carry related sentinels; files=${slice(JSON.stringify(files), 900)}`
					);
				});
				for (const [label, who, sentinels] of [
					['role 1', 'x1', ALL_SENTINELS],
					['role 2', 'x2', [CUST_EMAIL, NOTE_TEXT]],
				] as const) {
					test(`export ${format} ${name} ${label}: file carries no ungranted sentinel`, async () => {
						const { start, job, files } = await runExport(auth[who], format, mkSearch(), `${who}-${format}`);
						console.log(
							`export ${format} ${name} ${who}: start=${start.status} startBody=${start.text.slice(0, 300)} job=${JSON.stringify(job)?.slice(0, 400)} files=${slice(JSON.stringify(files), 1200)}`
						);
						// these roles carry the export_local grant (X0 pins the 403 for the roles that do not), so the job must run
						strictEqual(
							start.status,
							200,
							`export must start for an export-granted role: ${start.status} ${start.text}`
						);
						strictEqual(job.status, 'COMPLETE', JSON.stringify(job));
						const all = Object.values(files).join('\n');
						ok(
							all.includes('o1') && all.includes('o2') && all.includes('widget'),
							`granted Order rows must be in the export file; files=${slice(JSON.stringify(files), 900)}`
						);
						const found = (sentinels as string[]).filter((s) => all.includes(s));
						ok(
							found.length === 0,
							`export ${format} ${name} ${who} leaked ${JSON.stringify(found)}; files=${slice(JSON.stringify(files), 900)}`
						);
					});
				}
			}
		}
	}
);
