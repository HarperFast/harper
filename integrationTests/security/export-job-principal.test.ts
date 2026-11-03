// SQA-101 — does the authenticated principal, with its table and attribute permissions, survive into
// the surfaces that run a search on the caller's behalf somewhere other than the request thread:
//   the `export_local` background job (server/jobs/jobProcess.ts re-reads the persisted request
//   from system.hdb_job and runs dataLayer/export.ts getRecords, which forwards exportObject.hdb_user
//   into the nested search_operation). The MCP operations-tool leg is sqa101-mcp-search-conditions.test.ts.
// Contract under test (resources/FULL_TEXT.md "Fields, permissions, and results"; reference/database/
// schema.md attribute_permissions): a caller must be allowed to read every source a full-text condition
// searches, and a read:false attribute is never delivered — on every surface, including a job that
// runs after the request has been answered.
// QA: SQA-101 / SP-73. Role shape: `operations: ['export_local', 'get_job', 'search_*']` grants the requires_su export through gate 2
// (utility/operation_authorization.ts:898); the nested search is authorized at dispatch against its
// real handler (3aa382617), and again inside the job by Table.search with the persisted user.
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve, join } from 'node:path';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fulltext-source-authz-fixture');
const SCRATCH_ROOT = resolve(process.env.HOME ?? '/tmp', 'dev/tmp/agent-tmp');
const OPTIONS = {
	config: { threads: { count: 2 } },
	env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
};
const PASSWORD = 'Sqa101-export-4417!';
const READER = 'sqa101_reader'; // description read:false, may export
const ALL = 'sqa101_all'; // every source readable, may export — positive control
const SOURCES = ['id', 'title', 'description', 'tags', 'category', 'owner'];
const DENIED = 'description';
const SENTINEL = 'classified';

function basic(user: string) {
	return `Basic ${Buffer.from(`${user}:${PASSWORD}`).toString('base64')}`;
}
function ids(records: any[]): string[] {
	return records.map(({ id }) => id).sort();
}
function ft(value: string, extra: Record<string, unknown> = {}) {
	return {
		attribute: 'catalogSearch',
		comparator: 'matches',
		value,
		maxIndexLagMilliseconds: 0,
		waitForIndexMilliseconds: 30_000,
		...extra,
	};
}
function hasDenied(records: any[]): string[] {
	return records.filter((record) => Object.hasOwn(record, DENIED)).map(({ id }) => id);
}

suite('SQA-101 principal survives into the export_local job', (ctx: ContextWithHarper) => {
	let admin: string;
	let exportDir: string;

	async function op(body: Record<string, unknown>, auth = admin) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(45_000),
		});
		const text = await response.text();
		let parsed: any = text;
		try {
			parsed = JSON.parse(text);
		} catch {}
		return { status: response.status, text, body: parsed };
	}
	async function expectOp(body: Record<string, unknown>, auth: string, status: number) {
		const result = await op(body, auth);
		assert.strictEqual(result.status, status, `${body.operation} as ${auth.slice(6, 14)}…: ${result.text}`);
		return result;
	}
	function searchOp(conditions: unknown[], get_attributes: unknown = ['*'], extra: Record<string, unknown> = {}) {
		return {
			operation: 'search_by_conditions',
			database: 'data',
			table: 'Product',
			get_attributes,
			conditions,
			...extra,
		};
	}
	function exportOp(filename: string, search_operation: Record<string, unknown>) {
		return { operation: 'export_local', format: 'json', path: exportDir, filename, search_operation };
	}
	function exportFile(filename: string) {
		return join(exportDir, `${filename}.json`);
	}
	async function waitForTerminalJob(jobId: string, auth = admin, timeoutMs = 60_000) {
		const deadline = Date.now() + timeoutMs;
		let job: any;
		while (Date.now() < deadline) {
			const r = await expectOp({ operation: 'get_job', id: jobId }, auth, 200);
			job = Array.isArray(r.body) ? r.body[0] : r.body;
			if (job?.status === 'COMPLETE' || job?.status === 'ERROR') return job;
			await delay(200);
		}
		assert.fail(`job ${jobId} did not reach a terminal state: ${JSON.stringify(job)}`);
	}
	/** Starts an export as `auth`, waits for the job, returns {start, job, rows|undefined}. */
	async function runExport(filename: string, search_operation: Record<string, unknown>, auth: string) {
		const start = await op(exportOp(filename, search_operation), auth);
		if (start.status !== 200) return { start, job: undefined, rows: undefined };
		const jobId = start.body?.job_id;
		assert.ok(jobId, `expected a job_id: ${start.text}`);
		const job = await waitForTerminalJob(jobId, auth);
		const file = exportFile(filename);
		const rows = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
		return { start, job, rows, jobId };
	}
	async function addRole(role: string, attributePermissions: Array<{ attribute_name: string; read: boolean }>) {
		await expectOp(
			{
				operation: 'add_role',
				role,
				permission: {
					super_user: false,
					operations: ['export_local', 'get_job', 'search_by_conditions', 'search_by_value', 'search_by_hash'],
					data: {
						tables: {
							Product: {
								read: true,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: attributePermissions.map((entry) => ({
									...entry,
									insert: false,
									update: false,
								})),
							},
						},
					},
				},
			},
			admin,
			200
		);
		await expectOp({ operation: 'add_user', username: role, password: PASSWORD, role, active: true }, admin, 200);
	}
	before(async () => {
		mkdirSync(SCRATCH_ROOT, { recursive: true });
		exportDir = mkdtempSync(join(SCRATCH_ROOT, 'sqa101-export-'));
		await setupHarperWithFixture(ctx, FIXTURE_PATH, OPTIONS);
		admin = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
		await expectOp(
			{
				operation: 'insert',
				schema: 'data',
				table: 'Product',
				records: [
					{ id: 'one', title: 'Waterproof Trail Running Shoes', description: 'public note', owner: READER },
					{ id: 'two', title: 'Waterproof Road Shoes', description: 'road note', owner: READER },
					{ id: 'three', title: 'Wireless Headphones', tags: ['electronics'], owner: READER },
					{ id: 'hidden-desc', title: 'Garden', description: `${SENTINEL} sentinel`, owner: READER },
					{ id: 'private', title: 'Private nebula', description: `${SENTINEL} waterproof`, owner: 'another-user' },
				],
			},
			admin,
			200
		);
		await addRole(
			READER,
			SOURCES.map((attribute_name) => ({ attribute_name, read: attribute_name !== DENIED }))
		);
		await addRole(
			ALL,
			SOURCES.map((attribute_name) => ({ attribute_name, read: true }))
		);
		// readiness: the index reports ready and the admin query converges
		const deadline = Date.now() + 60_000;
		for (;;) {
			const description = await op({ operation: 'describe_table', schema: 'data', table: 'Product' });
			const state = description.body?.full_text_indexes?.[0]?.readiness?.state;
			if (state === 'ready') {
				const result = await op(searchOp([ft(SENTINEL)], ['id']));
				if (result.status === 200 && ids(result.body).join() === ['hidden-desc', 'private'].join()) break;
			}
			assert.ok(Date.now() < deadline, `index not ready / not converged: ${JSON.stringify(description.body)}`);
			await delay(100);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
		if (exportDir) rmSync(exportDir, { recursive: true, force: true });
	});

	test('E0 precondition: on the request thread the reader is refused on the denied source and narrowed on *', async () => {
		await expectOp(searchOp([ft(SENTINEL)]), basic(READER), 403);
		await expectOp(searchOp([ft(SENTINEL, { fields: [DENIED] })]), basic(READER), 403);
		const narrowed = await expectOp(searchOp([ft('waterproof', { fields: ['title'] })]), basic(READER), 200);
		assert.deepStrictEqual(ids(narrowed.body), ['one', 'two']);
		assert.deepStrictEqual(hasDenied(narrowed.body), [], `request-thread * delivered ${DENIED}`);
		const asAll = await expectOp(searchOp([ft(SENTINEL)]), basic(ALL), 200);
		assert.deepStrictEqual(ids(asAll.body), ['hidden-desc', 'private']);
	});

	test('E1 export job, full-text leaf on the denied source: refused, no file', async () => {
		const { start, job, rows } = await runExport(
			'e1-reader-denied',
			searchOp([ft(SENTINEL)], ['id', 'title']),
			basic(READER)
		);
		assert.strictEqual(rows, undefined, `export file written for a denied search: ${JSON.stringify(rows)}`);
		if (start.status === 200) {
			assert.strictEqual(job.status, 'ERROR', `job did not refuse: ${JSON.stringify(job)}`);
			assert.match(
				JSON.stringify(job.message),
				/permission|not allowed|access|authoriz|403/i,
				`job error is not a permission refusal: ${JSON.stringify(job.message)}`
			);
		} else {
			assert.strictEqual(start.status, 403, `unexpected dispatch status: ${start.text}`);
		}
	});

	test('E1b positive control: the same export as the all-sources role completes and carries the sentinel rows', async () => {
		const { start, job, rows } = await runExport(
			'e1-all',
			searchOp([ft(SENTINEL)], ['id', 'title', DENIED]),
			basic(ALL)
		);
		assert.strictEqual(start.status, 200, start.text);
		assert.strictEqual(job.status, 'COMPLETE', JSON.stringify(job));
		assert.deepStrictEqual(ids(rows), ['hidden-desc', 'private']);
		assert.deepStrictEqual(
			hasDenied(rows).sort(),
			['hidden-desc', 'private'],
			'control must deliver the field it is allowed'
		);
	});

	test('E2 export job, explicit get_attributes naming the denied attribute: refused, no file', async () => {
		const { start, job, rows } = await runExport(
			'e2-reader-explicit',
			searchOp([ft('waterproof', { fields: ['title'] })], ['id', 'title', DENIED]),
			basic(READER)
		);
		assert.strictEqual(rows, undefined, `export file written: ${JSON.stringify(rows)}`);
		if (start.status === 200) assert.strictEqual(job.status, 'ERROR', JSON.stringify(job));
		else assert.strictEqual(start.status, 403, start.text);
	});

	test('E3 export job, readable full-text leaf with get_attributes *: completes, file never carries the denied attribute', async () => {
		const { start, job, rows } = await runExport(
			'e3-reader-star',
			searchOp([ft('waterproof', { fields: ['title'] })]),
			basic(READER)
		);
		assert.strictEqual(start.status, 200, start.text);
		assert.strictEqual(job.status, 'COMPLETE', JSON.stringify(job));
		assert.deepStrictEqual(ids(rows), ['one', 'two']);
		assert.deepStrictEqual(
			hasDenied(rows),
			[],
			`the job delivered ${DENIED} to a read:false role: ${JSON.stringify(rows)}`
		);
		assert.ok(
			rows.every((r: any) => Object.hasOwn(r, 'title')),
			'readable attributes still exported'
		);
	});

	test('E4 export job, non-full-text search_by_value with get_attributes *: file never carries the denied attribute', async () => {
		const { start, job, rows } = await runExport(
			'e4-reader-value',
			{
				operation: 'search_by_value',
				database: 'data',
				table: 'Product',
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['*'],
			},
			basic(READER)
		);
		assert.strictEqual(start.status, 200, start.text);
		assert.strictEqual(job.status, 'COMPLETE', JSON.stringify(job));
		assert.deepStrictEqual(ids(rows), ['hidden-desc', 'one', 'private', 'three', 'two']);
		assert.deepStrictEqual(hasDenied(rows), [], `the job delivered ${DENIED}: ${JSON.stringify(rows)}`);
		// control for the oracle: the same export as ALL carries the attribute on the rows that have it
		const all = await runExport(
			'e4-all-value',
			{
				operation: 'search_by_value',
				database: 'data',
				table: 'Product',
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['*'],
			},
			basic(ALL)
		);
		assert.strictEqual(all.job.status, 'COMPLETE', JSON.stringify(all.job));
		const withValue = all.rows
			.filter((r: any) => r[DENIED] != null)
			.map(({ id }: any) => id)
			.sort();
		assert.deepStrictEqual(
			withValue,
			['hidden-desc', 'one', 'private', 'two'],
			`control rows: ${JSON.stringify(all.rows)}`
		);
	});

	test('E5 the persisted job request carries the principal with its role but no password material', async () => {
		// jobProcess.ts clears `request` when the job completes, so the row is read while the worker boots
		const start = await expectOp(
			exportOp('e5-reader-row', searchOp([ft('waterproof', { fields: ['title'] })], ['id'])),
			basic(READER),
			200
		);
		const jobId = start.body?.job_id;
		assert.ok(jobId, start.text);
		let request: any;
		let observed: any;
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const row = await expectOp(
				{
					operation: 'search_by_hash',
					schema: 'system',
					table: 'hdb_job',
					hash_values: [jobId],
					get_attributes: ['*'],
				},
				admin,
				200
			);
			observed = row.body?.[0];
			if (observed?.request) {
				request = observed.request;
				break;
			}
			if (observed?.status === 'COMPLETE' || observed?.status === 'ERROR') break;
			await delay(5);
		}
		assert.ok(request, `pending job row never showed its request (cleared on completion): ${JSON.stringify(observed)}`);
		assert.strictEqual(request.hdb_user?.username, READER, 'the job row persists the principal');
		assert.ok(request.hdb_user?.role?.permission, 'the persisted principal carries its permission');
		assert.ok(
			!Object.hasOwn(request.hdb_user, 'password'),
			`password material persisted: ${Object.keys(request.hdb_user)}`
		);
		assert.strictEqual(
			JSON.stringify(request).includes(PASSWORD),
			false,
			'the plaintext password is not in the job row'
		);
		const job = await waitForTerminalJob(jobId);
		assert.strictEqual(job.status, 'COMPLETE', JSON.stringify(job));
		const cleared = await expectOp(
			{ operation: 'search_by_hash', schema: 'system', table: 'hdb_job', hash_values: [jobId], get_attributes: ['*'] },
			admin,
			200
		);
		assert.strictEqual(cleared.body?.[0]?.request, undefined, 'the principal does not outlive the job in the row');
	});
});
