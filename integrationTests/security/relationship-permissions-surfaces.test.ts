/**
 * Reading through an `@relationship` applies the role's permissions on the related table: in the nested
 * search of an `export_local` job, through a many-to-many or reverse (`to:`) relationship, on an unindexed
 * related attribute, and in a live SSE subscription whose related-table or related-attribute grant is
 * revoked while the stream is open. The request path is anchored in
 * `relationship-related-table-permissions.test.ts`.
 *
 * Every surface resolves a relationship path through `Table._readDenial`: the operations API through
 * `checkRelationshipReads` (`utility/operation_authorization.ts`; for `export_local` the nested
 * `search_operation` is the permission subject, `server/serverHelpers/serverUtilities.ts`) and a `*`
 * expansion that omits the relationship, the export job by re-running the search as the caller
 * (`dataLayer/export.ts`), and an open subscription by the role-change recheck that re-runs `allowRead`
 * (`server/liveSubscriptionAuth.ts`, `Resource.ts` `registerLiveSubscriptionForContext`).
 *
 * Run:
 *   npm run build && npm run test:integration -- "integrationTests/security/relationship-permissions-surfaces.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/relationship-permissions-surfaces');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const DEPTS = [
	{ id: 'd1', label: 'Eng', secret: 'DEPT-SECRET-1', budget: 730019, plain: 'plain-aaa' },
	{ id: 'd2', label: 'Ops', secret: 'DEPT-SECRET-2', budget: 588471, plain: 'plain-bbb' },
	{ id: 'd3', label: 'Fin', secret: 'DEPT-SECRET-3', budget: 641203, plain: 'plain-ccc' },
	{ id: 'd4', label: 'Hr', secret: 'DEPT-SECRET-4', budget: 912377, plain: 'plain-ddd' },
];
const EMPS = [1, 2, 3, 4].map((n) => ({ id: `e${n}`, name: `emp${n}`, level: n, deptId: `d${n}` }));
const PROJS = [
	{ id: 'p1', title: 'proj1', deptIds: ['d1', 'd2'] },
	{ id: 'p2', title: 'proj2', deptIds: ['d3'] },
	{ id: 'p3', title: 'proj3', deptIds: ['d4'] },
];
const DEPT_LABEL = { id: 'd1', label: 'Eng' };

const READ = { read: true, insert: false, update: false, delete: false, attribute_permissions: [] };
const attribute = (attribute_name: string, read = true) => ({ attribute_name, read, insert: false, update: false });
const deptLabelOnly = { ...READ, attribute_permissions: [attribute('label')] };
const EXPORT_OPERATIONS = ['export_local', 'get_job', 'search_by_value', 'search_by_conditions'];

const ROLES = {
	full: { data: { tables: { Emp: READ, Proj: READ, Dept: READ } } },
	empOnly: { data: { tables: { Emp: READ, Proj: READ } } },
	deptLabel: { data: { tables: { Emp: READ, Proj: READ, Dept: deptLabelOnly } } },
	deptOnly: { data: { tables: { Dept: READ } } },
	revocable: { data: { tables: { Emp: READ, Dept: READ } } },
	attrRevocable: { data: { tables: { Emp: READ, Dept: deptLabelOnly } } },
	exportFull: { operations: EXPORT_OPERATIONS, data: { tables: { Emp: READ, Dept: READ } } },
	exportEmpOnly: { operations: EXPORT_OPERATIONS, data: { tables: { Emp: READ } } },
	exportDeptLabel: { operations: EXPORT_OPERATIONS, data: { tables: { Emp: READ, Dept: deptLabelOnly } } },
};
type RoleName = keyof typeof ROLES;
type Principal = RoleName | 'super';
const PASSWORD = 'Rel-surface-pw-3316!';
const REQUEST_TIMEOUT = 10_000;

const SECRETS = DEPTS.map((d) => d.secret);
const ids = (rows: any) => (Array.isArray(rows) ? rows.map((r) => r.id).sort() : rows);
const byId = (rows: any[], id: string) => rows.find((r) => r.id === id);

suite(
	'@relationship reads apply the related table permissions on every surface',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let restURL: string;
		let exportRoot: string;
		const headers = {} as Record<Principal, Record<string, string>>;
		const roleIds = {} as Record<RoleName, string>;
		const streams: Stream[] = [];

		async function op(as: Principal, body: any) {
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { ...headers[as], 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT),
			});
			return { status: response.status, body: await response.json() };
		}
		async function rest(as: Principal, path: string) {
			const response = await fetch(`${restURL}${path}`, {
				headers: { ...headers[as], Accept: 'application/json' },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT),
			});
			const text = await response.text();
			return { status: response.status, body: text ? JSON.parse(text) : undefined };
		}
		async function graphql(as: Principal, query: string) {
			const response = await fetch(`${restURL}/graphql`, {
				method: 'POST',
				headers: { ...headers[as], 'Content-Type': 'application/json' },
				body: JSON.stringify({ query }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT),
			});
			return { status: response.status, body: await response.json() };
		}
		function assertRefused(response: { status: number; body: any }, context: string, denied?: string) {
			strictEqual(
				response.status,
				403,
				`${context}: expected 403, got ${response.status} ${JSON.stringify(response.body)}`
			);
			if (!denied) return;
			const [table, attribute] = denied.split('.');
			deepStrictEqual(
				response.body?.invalid_schema_items,
				[
					attribute
						? `Attribute '${attribute}' does not exist on 'data.${table}'`
						: `Table 'data.${table}' does not exist`,
				],
				`${context}: ${JSON.stringify(response.body)}`
			);
		}
		function assertGraphqlRefused(response: { status: number; body: any }, context: string) {
			const message = response.body?.errors?.[0]?.message;
			strictEqual(message, 'Unauthorized access to resource', `${context}: ${JSON.stringify(response.body)}`);
			strictEqual(response.body?.data, undefined, `${context}: ${JSON.stringify(response.body)}`);
		}
		function assertNarrowedToLabel(project: any, context: string) {
			const text = JSON.stringify(project);
			for (const secret of SECRETS) ok(!text.includes(secret), `${context}: ${text}`);
			deepStrictEqual(
				project.depts.map((dept: any) => ({ label: dept.label, secret: dept.secret })),
				[
					{ label: 'Eng', secret: undefined },
					{ label: 'Ops', secret: undefined },
				],
				`${context}: ${text}`
			);
		}

		async function exportSearch(as: Principal, search_operation: Record<string, unknown>) {
			const path = mkdtempSync(join(exportRoot, `${as}-`));
			const start = await op(as, {
				operation: 'export_local',
				format: 'json',
				path,
				search_operation: { table: 'Emp', ...search_operation },
			});
			if (start.status !== 200) return { status: start.status, body: start.body, rows: undefined };
			const jobId = start.body.job_id;
			ok(jobId, `${as}: ${JSON.stringify(start.body)}`);
			const deadline = Date.now() + 20_000;
			let job: any;
			while (Date.now() < deadline) {
				const response = await op('super', { operation: 'get_job', id: jobId });
				job = Array.isArray(response.body) ? response.body[0] : response.body;
				if (job?.status === 'COMPLETE' || job?.status === 'ERROR') break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			strictEqual(job?.status, 'COMPLETE', `${as}: ${JSON.stringify(job)}`);
			const [file] = readdirSync(path);
			ok(file, `${as}: no export file written`);
			return { status: 200, body: start.body, rows: JSON.parse(readFileSync(join(path, file), 'utf8')) as any[] };
		}
		const byValue = (get_attributes: any[]) => ({
			operation: 'search_by_value',
			search_attribute: 'id',
			search_value: '*',
			get_attributes,
		});
		const bySecret = (search_value: string) => ({
			operation: 'search_by_conditions',
			conditions: [{ search_attribute: ['dept', 'secret'], search_type: 'equals', search_value }],
			get_attributes: ['id'],
		});

		interface Stream {
			status: number;
			events: number;
			closed: boolean;
			closedBy?: 'server' | 'test' | 'error';
			abort: () => void;
		}
		async function subscribe(as: Principal, path: string): Promise<Stream> {
			const controller = new AbortController();
			const stream: Stream = { status: 0, events: 0, closed: false, abort: () => controller.abort() };
			streams.push(stream);
			// the deadline covers the handshake only: the signal stays attached to the body, so a timeout
			// signal would end the stream from this side later and read as a close by the server
			const handshake = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
			let response: Response;
			try {
				response = await fetch(`${restURL}${path}`, {
					headers: { ...headers[as], Accept: 'text/event-stream' },
					signal: controller.signal,
				});
			} finally {
				clearTimeout(handshake);
			}
			stream.status = response.status;
			if (response.status !== 200) {
				stream.closed = true;
				return stream;
			}
			strictEqual(response.headers.get('content-type')?.split(';')[0], 'text/event-stream', `${as} ${path}`);
			const reader = response.body!.getReader();
			controller.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}));
			const decoder = new TextDecoder();
			let buffered = '';
			void (async () => {
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						buffered += decoder.decode(value, { stream: true });
						const frames = buffered.split(/\r?\n\r?\n/);
						buffered = frames.pop()!;
						stream.events += frames.filter((frame) => /(^|\n)data:/.test(frame)).length;
					}
					stream.closedBy = 'server';
				} catch {
					stream.closedBy = controller.signal.aborted ? 'test' : 'error';
				}
				stream.closed = true;
			})();
			return stream;
		}
		async function waitFor(condition: () => boolean, context: string, ms = 5_000) {
			const deadline = Date.now() + ms;
			while (!condition()) {
				ok(Date.now() < deadline, `${context}: not observed within ${ms} ms`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		let level = 100;
		async function publish() {
			const response = await op('super', {
				operation: 'update',
				table: 'Emp',
				records: [{ id: 'e1', level: ++level }],
			});
			strictEqual(response.status, 200, JSON.stringify(response.body));
		}
		// a subscription first sends the records that currently match, so liveness is an event for a later write
		async function liveSubscription(as: Principal, path: string, currentRecords: number) {
			const stream = await subscribe(as, path);
			strictEqual(stream.status, 200, `${as} ${path}`);
			await waitFor(() => stream.events >= currentRecords, `${as} ${path} current records`);
			const before = stream.events;
			await publish();
			await waitFor(() => stream.events > before, `${as} ${path} delivers a write`);
			ok(!stream.closed, `${as} ${path} closed`);
			return stream;
		}

		before(async () => {
			exportRoot = mkdtempSync(join(tmpdir(), 'relationship-export-'));
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: 1 } },
				// a long periodic pass, so every revocation below comes from the targeted role-change recheck
				env: { AUTHENTICATION_AUTHORIZELOCAL: 'false', HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS: '600000' },
			});
			client = createApiClient(ctx.harper);
			restURL = ctx.harper.httpURL;
			headers.super = client.headers;
			for (const [name, permission] of Object.entries(ROLES) as [RoleName, any][]) {
				const role = `rel_surface_${name}`;
				const added = await op('super', {
					operation: 'add_role',
					role,
					permission: { super_user: false, ...permission },
				});
				strictEqual(added.status, 200, JSON.stringify(added.body));
				roleIds[name] = added.body.id;
				const username = `rel_surface_${name}`;
				const user = await op('super', { operation: 'add_user', role, username, password: PASSWORD, active: true });
				strictEqual(user.status, 200, JSON.stringify(user.body));
				headers[name] = { Authorization: `Basic ${Buffer.from(`${username}:${PASSWORD}`).toString('base64')}` };
			}
			for (const [table, records] of [
				['Dept', DEPTS],
				['Emp', EMPS],
				['Proj', PROJS],
			] as const) {
				const inserted = await op('super', { operation: 'insert', table, records });
				strictEqual(inserted.status, 200, JSON.stringify(inserted.body));
			}
		});

		after(async () => {
			for (const stream of streams) stream.abort();
			await teardownHarper(ctx);
			rmSync(exportRoot, { recursive: true, force: true });
		});

		suite('export_local runs its nested search with the caller’s related-table permissions', () => {
			test('a role that can read the related table exports it', async () => {
				const named = await exportSearch('exportFull', byValue(['id', 'dept']));
				deepStrictEqual(byId(named.rows!, 'e1'), { id: 'e1', dept: DEPTS[0] });
				const star = await exportSearch('exportFull', byValue(['*']));
				deepStrictEqual(byId(star.rows!, 'e1'), { ...EMPS[0], dept: DEPTS[0] });
				const nested = await exportSearch('exportFull', byValue(['id', { name: 'dept', select: ['id', 'secret'] }]));
				deepStrictEqual(byId(nested.rows!, 'e1'), { id: 'e1', dept: { id: 'd1', secret: 'DEPT-SECRET-1' } });
				deepStrictEqual(ids((await exportSearch('exportFull', bySecret('DEPT-SECRET-1'))).rows), ['e1']);
				deepStrictEqual(ids((await exportSearch('exportFull', bySecret('DEPT-WRONG'))).rows), []);
			});
			test('naming, selecting into or filtering by a related table the role cannot read is refused before the job starts', async () => {
				assertRefused(await exportSearch('exportEmpOnly', byValue(['id', 'dept'])), 'empOnly [id, dept]', 'Dept');
				assertRefused(
					await exportSearch('exportEmpOnly', byValue(['id', { name: 'dept', select: ['id', 'secret'] }])),
					'empOnly nested select'
				);
				assertRefused(await exportSearch('exportEmpOnly', bySecret('DEPT-SECRET-1')), 'empOnly condition', 'Dept');
				assertRefused(await exportSearch('exportEmpOnly', bySecret('DEPT-WRONG')), 'empOnly condition, wrong value');
			});
			test('* omits a related table the role cannot read and narrows one it can partly read', async () => {
				const omitted = await exportSearch('exportEmpOnly', byValue(['*']));
				deepStrictEqual(byId(omitted.rows!, 'e1'), EMPS[0]);
				const narrowed = await exportSearch('exportDeptLabel', byValue(['*']));
				deepStrictEqual(byId(narrowed.rows!, 'e1'), { ...EMPS[0], dept: DEPT_LABEL });
				const named = await exportSearch('exportDeptLabel', byValue(['id', 'dept']));
				deepStrictEqual(byId(named.rows!, 'e1'), { id: 'e1', dept: DEPT_LABEL });
			});
			test('a related attribute the role cannot read is refused in a selection and in a condition', async () => {
				assertRefused(
					await exportSearch('exportDeptLabel', byValue(['id', { name: 'dept', select: ['id', 'secret'] }])),
					'deptLabel nested select of secret',
					'Dept.secret'
				);
				assertRefused(
					await exportSearch('exportDeptLabel', bySecret('DEPT-SECRET-1')),
					'deptLabel condition on secret',
					'Dept.secret'
				);
			});
		});

		suite('a many-to-many relationship', () => {
			const search = (as: Principal, get_attributes: any[]) =>
				op(as, {
					operation: 'search_by_value',
					table: 'Proj',
					search_attribute: 'id',
					search_value: '*',
					get_attributes,
				});

			test('resolves for a role that can read the related table', async () => {
				const named = await search('full', ['id', 'depts']);
				strictEqual(named.status, 200, JSON.stringify(named.body));
				deepStrictEqual(byId(named.body, 'p1'), { id: 'p1', depts: [DEPTS[0], DEPTS[1]] });
				const selected = await rest('full', '/Proj/?select(id,depts{id,label,secret})');
				deepStrictEqual(byId(selected.body, 'p1'), {
					id: 'p1',
					depts: [
						{ id: 'd1', label: 'Eng', secret: 'DEPT-SECRET-1' },
						{ id: 'd2', label: 'Ops', secret: 'DEPT-SECRET-2' },
					],
				});
				deepStrictEqual(ids((await rest('full', '/Proj/?depts.secret=DEPT-SECRET-1')).body), ['p1']);
				deepStrictEqual(ids((await rest('full', '/Proj/?depts.secret=DEPT-WRONG')).body), []);
				const filtered = await graphql('full', '{ Proj(depts: { secret: "DEPT-SECRET-1" }) { id } }');
				deepStrictEqual(filtered.body, { data: { Proj: [{ id: 'p1' }] } });
			});
			test('is refused, omitted or narrowed by the role’s related-table permissions', async () => {
				assertRefused(await search('empOnly', ['id', 'depts']), 'empOnly [id, depts]', 'Dept');
				const star = await search('empOnly', ['*']);
				deepStrictEqual(byId(star.body, 'p1'), PROJS[0]);
				deepStrictEqual(byId((await rest('empOnly', '/Proj/?select(id,depts{id,label,secret})')).body, 'p1'), {
					id: 'p1',
				});

				const narrowed = await search('deptLabel', ['id', 'depts']);
				deepStrictEqual(byId(narrowed.body, 'p1'), { id: 'p1', depts: [DEPT_LABEL, { id: 'd2', label: 'Ops' }] });
				deepStrictEqual(byId((await search('deptLabel', ['*'])).body, 'p1'), {
					...PROJS[0],
					depts: [DEPT_LABEL, { id: 'd2', label: 'Ops' }],
				});
				const selected = await rest('deptLabel', '/Proj/?select(id,depts{id,label,secret})');
				assertNarrowedToLabel(byId(selected.body, 'p1'), 'deptLabel REST selection');
				const graphqlSelected = await graphql('deptLabel', '{ Proj { id depts { id label secret } } }');
				assertNarrowedToLabel(byId(graphqlSelected.body.data.Proj, 'p1'), 'deptLabel GraphQL selection');

				for (const as of ['empOnly', 'deptLabel'] as const) {
					assertRefused(await rest(as, '/Proj/?depts.secret=DEPT-SECRET-1'), `${as} REST filter`);
					assertRefused(await rest(as, '/Proj/?depts.secret=DEPT-WRONG'), `${as} REST filter, wrong value`);
					assertGraphqlRefused(
						await graphql(as, '{ Proj(depts: { secret: "DEPT-SECRET-1" }) { id } }'),
						`${as} GraphQL filter`
					);
				}
			});
		});

		suite('a reverse relationship and an unindexed related attribute', () => {
			test('a reverse (to:) relationship is authorized against the related table', async () => {
				deepStrictEqual(ids((await rest('full', '/Dept/?members.name=emp1')).body), ['d1']);
				const members = await op('full', {
					operation: 'search_by_conditions',
					table: 'Dept',
					conditions: [{ search_attribute: ['members', 'name'], search_type: 'equals', search_value: 'emp1' }],
					get_attributes: ['id'],
				});
				deepStrictEqual(ids(members.body), ['d1']);
				deepStrictEqual(byId((await rest('full', '/Dept/?select(id,members{name})')).body, 'd1'), {
					id: 'd1',
					members: [{ name: 'emp1' }],
				});

				assertRefused(await rest('deptOnly', '/Dept/?members.name=emp1'), 'deptOnly REST filter');
				assertRefused(
					await op('deptOnly', {
						operation: 'search_by_conditions',
						table: 'Dept',
						conditions: [{ search_attribute: ['members', 'name'], search_type: 'equals', search_value: 'emp1' }],
						get_attributes: ['id'],
					}),
					'deptOnly operations filter',
					'Emp'
				);
				assertRefused(
					await op('deptOnly', {
						operation: 'search_by_value',
						table: 'Dept',
						search_attribute: 'id',
						search_value: '*',
						get_attributes: ['id', 'members'],
					}),
					'deptOnly [id, members]',
					'Emp'
				);
				deepStrictEqual(byId((await rest('deptOnly', '/Dept/?select(id,members{name})')).body, 'd1'), { id: 'd1' });
				assertGraphqlRefused(
					await graphql('deptOnly', '{ Dept(members: { name: "emp1" }) { id } }'),
					'deptOnly GraphQL filter'
				);
			});
			test('a condition on an unindexed related attribute is authorized like an indexed one', async () => {
				deepStrictEqual(ids((await rest('full', '/Emp/?dept.plain=plain-aaa')).body), ['e1']);
				deepStrictEqual(ids((await rest('empOnly', '/Emp/?level=1')).body), ['e1']);
				assertRefused(await rest('empOnly', '/Emp/?dept.plain=plain-aaa'), 'empOnly REST filter');
				assertRefused(await rest('empOnly', '/Emp/?dept.plain=plain-nope'), 'empOnly REST filter, wrong value');
				const search = (as: Principal) =>
					op(as, {
						operation: 'search_by_conditions',
						table: 'Emp',
						conditions: [{ search_attribute: ['dept', 'plain'], search_type: 'equals', search_value: 'plain-aaa' }],
						get_attributes: ['id'],
					});
				deepStrictEqual(ids((await search('full')).body), ['e1']);
				assertRefused(await search('empOnly'), 'empOnly operations filter', 'Dept');
			});
		});

		suite('live subscriptions through a relationship', () => {
			test('a subscription conditioned on a related table the role cannot read is refused', async () => {
				const live = await liveSubscription('full', '/Emp/?dept.secret=DEPT-SECRET-1', 1);
				live.abort();
				const plain = await liveSubscription('empOnly', '/Emp/?level=gt=0', EMPS.length);
				plain.abort();
				const refused = await subscribe('empOnly', '/Emp/?dept.secret=DEPT-SECRET-1');
				strictEqual(refused.status, 403);
			});
			test('revoking the related table closes the subscription conditioned on it and leaves a sibling open', async () => {
				const related = await liveSubscription('revocable', '/Emp/?dept.budget=gt=0', EMPS.length);
				const sibling = await liveSubscription('revocable', '/Emp/?level=gt=0', EMPS.length);
				ok(!related.closed, 'the relationship-conditioned stream closed before alter_role');

				const altered = await op('super', {
					operation: 'alter_role',
					id: roleIds.revocable,
					role: 'rel_surface_revocable',
					permission: { super_user: false, data: { tables: { Emp: READ } } },
				});
				strictEqual(altered.status, 200, JSON.stringify(altered.body));
				await waitFor(() => related.closed, 'relationship-conditioned stream closed after alter_role');
				strictEqual(related.closedBy, 'server');
				assertRefused(await rest('revocable', '/Emp/?dept.budget=gt=0'), 'revocable fresh request');

				const siblingEvents = sibling.events;
				await publish();
				await waitFor(() => sibling.events > siblingEvents, 'sibling stream delivers after alter_role');
				ok(!sibling.closed, 'the sibling stream closed');
				sibling.abort();
			});
			test('revoking a related attribute grant closes the subscription conditioned on that attribute', async () => {
				const ungranted = await subscribe('attrRevocable', '/Emp/?dept.budget=gt=0');
				strictEqual(ungranted.status, 403);
				const related = await liveSubscription('attrRevocable', '/Emp/?dept.label=Eng', 1);
				const sibling = await liveSubscription('attrRevocable', '/Emp/?level=gt=0', EMPS.length);
				ok(!related.closed, 'the attribute-conditioned stream closed before alter_role');

				const altered = await op('super', {
					operation: 'alter_role',
					id: roleIds.attrRevocable,
					role: 'rel_surface_attrRevocable',
					permission: {
						super_user: false,
						data: { tables: { Emp: READ, Dept: { ...READ, attribute_permissions: [attribute('plain')] } } },
					},
				});
				strictEqual(altered.status, 200, JSON.stringify(altered.body));
				await waitFor(() => related.closed, 'attribute-conditioned stream closed after alter_role');
				strictEqual(related.closedBy, 'server');
				assertRefused(await rest('attrRevocable', '/Emp/?dept.label=Eng'), 'attrRevocable fresh request');

				const siblingEvents = sibling.events;
				await publish();
				await waitFor(() => sibling.events > siblingEvents, 'sibling stream delivers after alter_role');
				ok(!sibling.closed, 'the sibling stream closed');
				sibling.abort();
			});
		});
	}
);
