/**
 * QA-F078 — GraphQL read path: per-row allowRead enforcement.
 *
 * Background:
 *   The allowRead family (harper#1487) is partially tested on REST but the GraphQL
 *   surface has an open gap: does GraphQL filter per-row results through allowRead?
 *   This experiment targets three GraphQL paths:
 *     1. Collection query    — { Secret { id owner } }
 *     2. Single-record query — { Secret(id: "<bob-id>") { id owner } }
 *     3. Relationship expansion — { Secret { id attachments { data } } }
 *
 * Setup:
 *   - Secret table: allowRead override in resources.js; owner === username is the gate.
 *   - Attachment table: default allowRead (no per-row restriction); linked via secretId.
 *   - Two non-admin users: alice and bob. Each owns one Secret + one Attachment.
 *   - Role has full table-level CRUD on both tables so only the allowRead hook gates access.
 *   - AUTHENTICATION_AUTHORIZELOCAL=false — auth is always enforced; no header = 401.
 *     NOTE: this env is passed as a string; the server interprets truthy string.
 *     Instead, we distinguish auth by using explicit headers vs no-header and checking
 *     the admin (super_user) path returns all rows.
 *
 * Key behavior finding:
 *   GraphQL calls allowRead ONCE at the collection entry (before iteration), on an
 *   unloaded resource instance where `this.owner` is undefined. This differs from REST,
 *   which calls allowRead per-record with the loaded record data.
 *   Result: any non-super user with an owner-based allowRead gets 500 for ALL GraphQL
 *   reads (even their own rows), while super users get full access.
 *
 *   Security verdict: No data leak (bob's data does NOT reach alice), but alice
 *   also cannot read her own rows via GraphQL — a correctness/usability gap.
 *
 * REST surface (positive controls):
 *   - REST GET alice's row → 200 (per-row allowRead works for owner)
 *   - REST GET bob's row as alice → 403 (per-row allowRead denies cross-owner)
 *
 * Reproduction:
 *   npm run build && \
 *   npm run test:integration -- "integrationTests/qa-scratch/qa-gql-allowread.test.ts"
 * Harper SHA: 1b45db9ea
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import request from 'supertest';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa-gql-allowread');
const skipSuite = process.platform === 'win32';

const ALICE = { username: 'alice', password: 'Alice-pw-123!' };
const BOB = { username: 'bob', password: 'Bobby-pw-123!' };
const ROLE = 'f078_owner';

const ALICE_SECRET_ID = 'secret-alice-1';
const BOB_SECRET_ID = 'secret-bob-1';
const ALICE_ATTACH_ID = 'attach-alice-1';
const BOB_ATTACH_ID = 'attach-bob-1';

// Sentinel values — searching for these in responses reveals leaks.
const BOB_PAYLOAD = 'bob-secret-payload-sentinel';
const BOB_ATTACH_DATA = 'bob-attachment-data-sentinel';

interface Finding {
	surface: string;
	op: string;
	verdict: 'CORRECT' | 'LEAK' | 'INCONCLUSIVE';
	detail: string;
}

suite('QA-F078 GraphQL per-row allowRead enforcement', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let restURL: string;
	let aliceHeaders: Record<string, string>;

	const findings: Finding[] = [];
	function record(surface: string, op: string, verdict: Finding['verdict'], detail: string) {
		findings.push({ surface, op, verdict, detail });
	}

	function bodyContainsBobData(body: unknown): boolean {
		const s = JSON.stringify(body ?? null);
		return s.includes(BOB_PAYLOAD) || s.includes(BOB_ATTACH_DATA);
	}

	async function gql(query: string, headers: Record<string, string>) {
		return request(restURL)
			.post('/graphql')
			.set({ ...headers, 'Content-Type': 'application/json' })
			.send(JSON.stringify({ query }));
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {},
			env: {},
		});
		client = createApiClient(ctx.harper);
		restURL = ctx.harper.httpURL;
		aliceHeaders = createHeaders(ALICE.username, ALICE.password);

		// Wait for Secret route to be ready.
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Secret/').timeout(3_000);
				if (probe.status !== 404) break;
			} catch {
				/* not ready */
			}
			await sleep(250);
		}

		// Non-super role with full table-level CRUD on Secret and Attachment.
		await client
			.req()
			.send({
				operation: 'add_role',
				role: ROLE,
				permission: {
					super_user: false,
					data: {
						tables: {
							Secret: { read: true, insert: true, update: true, delete: true, attribute_permissions: [] },
							Attachment: { read: true, insert: true, update: true, delete: true, attribute_permissions: [] },
						},
					},
				},
			})
			.expect(200);

		for (const u of [ALICE, BOB]) {
			await client
				.req()
				.send({ operation: 'add_user', role: ROLE, username: u.username, password: u.password, active: true })
				.expect(200);
		}

		// Seed rows as admin (bypasses allowRead/allowCreate checks).
		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'data',
				table: 'Secret',
				records: [
					{ id: ALICE_SECRET_ID, owner: 'alice', payload: 'alice-secret-payload' },
					{ id: BOB_SECRET_ID, owner: 'bob', payload: BOB_PAYLOAD },
				],
			})
			.expect(200);

		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'data',
				table: 'Attachment',
				records: [
					{ id: ALICE_ATTACH_ID, secretId: ALICE_SECRET_ID, data: 'alice-attachment-data' },
					{ id: BOB_ATTACH_ID, secretId: BOB_SECRET_ID, data: BOB_ATTACH_DATA },
				],
			})
			.expect(200);

		await sleep(600); // index settle
	});

	after(async () => {
		console.log('\n===== QA-F078 GraphQL allowRead enforcement matrix =====');
		console.log('surface  | operation                               | verdict       | detail');
		console.log('---------+-----------------------------------------+---------------+------------------------------');
		for (const f of findings) {
			const flag = f.verdict === 'LEAK' ? '  <== BYPASS' : f.verdict === 'INCONCLUSIVE' ? '  <== CHECK' : '';
			console.log(
				`${f.surface.padEnd(8)} | ${f.op.padEnd(39)} | ${f.verdict.padEnd(13)} | ${f.detail}${flag}`
			);
		}
		const leaks = findings.filter((f) => f.verdict === 'LEAK').length;
		const inconclusives = findings.filter((f) => f.verdict === 'INCONCLUSIVE').length;
		console.log('=========================================================');
		console.log(
			leaks > 0
				? `DEFECT: ${leaks} GraphQL path(s) leak bob's data to alice — per-row allowRead BYPASSED on GraphQL.`
				: inconclusives > 0
					? `INCONCLUSIVE: ${inconclusives} path(s) could not be determined. ${findings.filter((f) => f.verdict === 'CORRECT').length} paths confirmed correct.`
					: `CORRECT: all ${findings.length} paths enforced allowRead as expected.`
		);
		console.log('=========================================================\n');
		await teardownHarper(ctx);
	});

	// ---- Positive controls: prove setup is valid ----

	test('CONTROL: admin sees both Secret rows (setup valid)', async () => {
		const r = await gql('{ Secret { id owner payload } }', client.headers);
		const rows: any[] = r.body?.data?.Secret ?? [];
		const ids = rows.map((x: any) => x?.id).sort();
		console.log(`\n[F078 CONTROL admin] GQL collection: status=${r.status} ids=${JSON.stringify(ids)}`);
		ok(
			ids.includes(ALICE_SECRET_ID) && ids.includes(BOB_SECRET_ID),
			`admin should see both rows, got: ${JSON.stringify(ids)} (errors: ${JSON.stringify(r.body?.errors ?? [])})`
		);
	});

	test('CONTROL: REST alice reads her own Secret → 200', async () => {
		const r = await request(restURL).get(`/Secret/${ALICE_SECRET_ID}`).set(aliceHeaders);
		console.log(`\n[F078 CONTROL alice-own-rest] GET /Secret/alice: status=${r.status}`);
		record('REST', 'GET /Secret/alice (positive control)', r.status === 200 ? 'CORRECT' : 'INCONCLUSIVE', `status ${r.status}`);
		strictEqual(r.status, 200, `alice should read her own row, got ${r.status}: ${r.text?.slice(0, 200)}`);
	});

	test('CONTROL: REST alice denied bob Secret → 403', async () => {
		const r = await request(restURL).get(`/Secret/${BOB_SECRET_ID}`).set(aliceHeaders);
		console.log(`\n[F078 CONTROL alice-bob-rest] GET /Secret/bob: status=${r.status}`);
		record(
			'REST',
			'GET /Secret/bob (baseline allowRead anchor)',
			r.status === 403 || r.status === 401 || r.status === 404 ? 'CORRECT' : 'LEAK',
			`status ${r.status}`
		);
		ok(
			r.status === 403 || r.status === 401 || r.status === 404,
			`allowRead not effective on REST: alice got ${r.status} on bob's row — baseline broken`
		);
	});

	// ---- GraphQL surface tests: security check (no leak) ----

	test('GQL collection: alice should NOT see bob Secret row (no data leak)', async () => {
		const r = await gql('{ Secret { id owner payload } }', aliceHeaders);
		const rows: any[] = r.body?.data?.Secret ?? [];
		const ids = rows.map((x: any) => x?.id);
		const leak = r.status === 200 && bodyContainsBobData(r.body);
		const hasBobId = ids.includes(BOB_SECRET_ID);

		console.log(`\n[F078 GQL collection] status=${r.status} ids=${JSON.stringify(ids)} errors=${JSON.stringify(r.body?.errors ?? []).slice(0, 200)}`);
		console.log(`  payload sentinel present: ${leak} | bob id present: ${hasBobId}`);

		// Characterize the behavior for the matrix.
		let verdict: Finding['verdict'];
		if (leak || hasBobId) {
			verdict = 'LEAK';
			console.log(`  DEFECT: alice received bob's Secret via GraphQL collection`);
		} else if (r.status === 500) {
			verdict = 'CORRECT';
			console.log(`  NOTE: GraphQL calls allowRead on unloaded resource (this.owner=undefined → deny → 500).`);
			console.log(`  Security: no leak. Usability gap: alice cannot read her OWN rows via GraphQL.`);
		} else if (rows.length > 0 && ids.includes(ALICE_SECRET_ID) && !hasBobId) {
			verdict = 'CORRECT';
			console.log(`  CORRECT: per-row filtering works — alice sees only her own row`);
		} else {
			verdict = 'INCONCLUSIVE';
		}

		record(
			'GraphQL',
			'collection { Secret { id owner payload } }',
			verdict,
			`status ${r.status}, ids=${JSON.stringify(ids)}`
		);

		// Primary security assertion: bob's data must NOT appear.
		ok(!leak, `LEAK: GraphQL collection returned bob's Secret payload to alice: ${JSON.stringify(r.body).slice(0, 300)}`);
		ok(!hasBobId, `LEAK: GraphQL collection included bob's Secret id (${BOB_SECRET_ID}) in response to alice`);
	});

	test('GQL single-record: alice querying bob Secret id should get null/error (no data leak)', async () => {
		const r = await gql(`{ Secret(id: "${BOB_SECRET_ID}") { id owner payload } }`, aliceHeaders);
		const rows: any[] = r.body?.data?.Secret ?? [];
		const leak = r.status === 200 && bodyContainsBobData(r.body);
		const hasBobData = rows.some((x: any) => x?.id === BOB_SECRET_ID || x?.payload === BOB_PAYLOAD);

		console.log(`\n[F078 GQL single] status=${r.status} rows=${rows.length} errors=${JSON.stringify(r.body?.errors ?? []).slice(0, 150)}`);
		console.log(`  payload sentinel present: ${leak} | bob data in result: ${hasBobData}`);

		record(
			'GraphQL',
			`single-record Secret(id: "${BOB_SECRET_ID}")`,
			leak || hasBobData ? 'LEAK' : 'CORRECT',
			`status ${r.status}, rows=${rows.length}, hasBobData=${hasBobData}`
		);

		ok(!leak, `LEAK: GraphQL single-record returned bob's Secret to alice: ${JSON.stringify(r.body).slice(0, 300)}`);
		ok(!hasBobData, `LEAK: GraphQL single-record included bob's data in response to alice`);
	});

	test('GQL relationship expansion: alice should NOT see bob Attachment via Secret', async () => {
		// Alice queries all Secrets with attachment expansion.
		// If allowRead filters bob's Secret, bob's Attachment should not appear.
		const r = await gql('{ Secret { id owner attachments { id data } } }', aliceHeaders);
		const rows: any[] = r.body?.data?.Secret ?? [];
		const allAttachIds = rows.flatMap((x: any) => (x?.attachments ?? []).map((a: any) => a?.id));
		const leak = r.status === 200 && bodyContainsBobData(r.body);
		const hasBobAttach = allAttachIds.includes(BOB_ATTACH_ID);
		const hasBobRow = rows.some((x: any) => x?.id === BOB_SECRET_ID);

		console.log(`\n[F078 GQL relationship] status=${r.status} secretIds=${JSON.stringify(rows.map((x: any) => x?.id))} attachIds=${JSON.stringify(allAttachIds)}`);
		console.log(`  payload sentinel present: ${leak} | bob secret row: ${hasBobRow} | bob attachment: ${hasBobAttach}`);
		console.log(`  errors: ${JSON.stringify(r.body?.errors ?? []).slice(0, 200)}`);

		const verdict: Finding['verdict'] = leak || hasBobAttach || hasBobRow ? 'LEAK' : 'CORRECT';
		record(
			'GraphQL',
			'relationship { Secret { id attachments { id data } } }',
			verdict,
			`status ${r.status}, secrets=${rows.length}, attachIds=${JSON.stringify(allAttachIds)}`
		);

		ok(!leak, `LEAK: relationship expansion returned bob's data to alice: ${JSON.stringify(r.body).slice(0, 400)}`);
		ok(!hasBobAttach, `LEAK: bob's Attachment (${BOB_ATTACH_ID}) visible to alice via relationship expansion`);
		ok(!hasBobRow, `LEAK: bob's Secret visible to alice in relationship expansion query`);
	});

	test('GQL admin sees all rows (AUTHORIZELOCAL confirms super_user bypass)', async () => {
		// Admin (super_user) should see all rows because allowRead has isSuper() → true guard.
		// This confirms the test setup is valid and admin headers differ from alice headers.
		const r = await gql('{ Secret { id owner } }', client.headers);
		const rows: any[] = r.body?.data?.Secret ?? [];
		const ids = rows.map((x: any) => x?.id).sort();
		console.log(`\n[F078 admin bypass] GQL admin: status=${r.status} ids=${JSON.stringify(ids)}`);

		record(
			'GraphQL',
			'admin collection (super_user bypass control)',
			ids.includes(ALICE_SECRET_ID) && ids.includes(BOB_SECRET_ID) ? 'CORRECT' : 'INCONCLUSIVE',
			`status ${r.status}, ids=${JSON.stringify(ids)}`
		);

		ok(
			ids.includes(ALICE_SECRET_ID) && ids.includes(BOB_SECRET_ID),
			`admin should see both rows; got ${JSON.stringify(ids)}`
		);
		// Also confirm alice headers are different from admin (alice has own separate headers).
		ok(
			JSON.stringify(client.headers) !== JSON.stringify(aliceHeaders),
			'alice and admin headers must differ — guards against false-positive where alice is accidentally super_user'
		);
	});
});
