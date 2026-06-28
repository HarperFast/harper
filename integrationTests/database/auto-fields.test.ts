// @createdTime/@updatedTime auto-assign on insert, @createdTime preserved on PATCH/PUT, auto-UUID PK on id-omit, required-field 400, @sealed interactions. REST/ops/SQL parity.
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'auto-fields');

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

interface Finding {
	probe: string;
	verdict: 'CORRECT' | 'FOOTGUN' | 'GAP' | 'CORRECT-PARTIAL';
	detail: string;
}
const findings: Finding[] = [];

function logFinding(f: Finding) {
	findings.push(f);
	console.log(`[${f.verdict}] ${f.probe}: ${f.detail}`);
}

const ctx: ContextWithHarper = {} as any;

async function restGet(client: any, path: string) {
	try {
		const r = await client.reqRest(path).timeout(8_000);
		return { status: r.status as number, body: r.body };
	} catch {
		return { status: 0, body: null };
	}
}

async function restPut(client: any, path: string, body: Record<string, unknown>) {
	try {
		const r = await request(client.restURL).put(path).set(client.headers).send(body).timeout(8_000);
		return { status: r.status as number, body: r.body };
	} catch {
		return { status: 0, body: null };
	}
}

async function restPatch(client: any, path: string, body: Record<string, unknown>) {
	try {
		const r = await request(client.restURL).patch(path).set(client.headers).send(body).timeout(8_000);
		return { status: r.status as number, body: r.body };
	} catch {
		return { status: 0, body: null };
	}
}

async function restPost(client: any, path: string, body: Record<string, unknown>) {
	try {
		const r = await request(client.restURL).post(path).set(client.headers).send(body).timeout(8_000);
		return { status: r.status as number, body: r.body };
	} catch {
		return { status: 0, body: null };
	}
}

async function opsInsert(client: any, table: string, records: Record<string, unknown>[]) {
	try {
		const r = await client.req().send({ operation: 'insert', table, records }).timeout(8_000);
		return { status: r.status as number, body: r.body };
	} catch {
		return { status: 0, body: null };
	}
}

async function sqlQuery(client: any, sql: string) {
	try {
		const r = await client.req().send({ operation: 'sql', sql }).timeout(8_000);
		return { status: r.status as number, body: r.body };
	} catch {
		return { status: 0, body: null };
	}
}

suite('auto-fields: @createdTime, @updatedTime, auto-PK, required-field', { skip: skipSuite }, () => {
	let client: ReturnType<typeof createApiClient>;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		// Poll for readiness
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const r = await client.reqRest('/AutoTimestamp/').timeout(3_000);
				if (r.status !== 404) break;
			} catch {
				// not ready yet
			}
			await sleep(300);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// (a)+(b): @createdTime and @updatedTime auto-populated on REST PUT insert
	test('(a-b) REST PUT insert: @createdTime and @updatedTime auto-assigned when omitted', async () => {
		const t0 = Date.now();
		const put = await restPut(client, '/AutoTimestamp/at-rest-1', { payload: 'hello' });
		const t1 = Date.now();
		ok(put.status === 200 || put.status === 204, `PUT should succeed; got ${put.status} body=${JSON.stringify(put.body)}`);

		const g = await restGet(client, '/AutoTimestamp/at-rest-1');
		strictEqual(g.status, 200, `GET after PUT should 200; got ${g.status}`);

		const { createdAt, updatedAt } = g.body;
		const createdAutoAssigned = typeof createdAt === 'number' && createdAt >= t0 && createdAt <= t1 + 1000;
		const updatedAutoAssigned = typeof updatedAt === 'number' && updatedAt >= t0 && updatedAt <= t1 + 1000;

		if (createdAutoAssigned && updatedAutoAssigned) {
			logFinding({ probe: 'a-b-REST-insert', verdict: 'CORRECT', detail: `@createdTime=${createdAt} @updatedTime=${updatedAt} both auto-set on insert` });
		} else {
			logFinding({
				probe: 'a-b-REST-insert',
				verdict: 'FOOTGUN',
				detail: `createdAt=${createdAt} (ok=${createdAutoAssigned}) updatedAt=${updatedAt} (ok=${updatedAutoAssigned}) — auto-assignment may be broken`,
			});
		}
		ok(createdAutoAssigned, `@createdTime should be auto-set on insert; got createdAt=${createdAt}, window=[${t0},${t1 + 1000}]`);
		ok(updatedAutoAssigned, `@updatedTime should be auto-set on insert; got updatedAt=${updatedAt}, window=[${t0},${t1 + 1000}]`);
	});

	// (c): Auto-generated PK when omitted on POST
	test('(c) Auto-generated PK: POST without id returns an assigned PK', async () => {
		const post = await restPost(client, '/AutoTimestamp/', { payload: 'auto-pk-test' });
		// Harper may return 200/201 with body, or 204 — check for assigned PK
		ok(post.status >= 200 && post.status < 300, `POST should succeed; got ${post.status} body=${JSON.stringify(post.body)}`);

		// If the body contains an id, confirm it looks like a UUID/auto-generated string
		const assignedId = post.body?.id ?? post.body;
		if (assignedId && typeof assignedId === 'string' && assignedId.length > 0) {
			logFinding({ probe: 'c-auto-pk-POST', verdict: 'CORRECT', detail: `auto-PK assigned=${assignedId}` });
		} else if (assignedId && typeof assignedId === 'object') {
			// may be a wrapped response
			logFinding({ probe: 'c-auto-pk-POST', verdict: 'CORRECT', detail: `auto-PK assigned (object response)=${JSON.stringify(assignedId)}` });
		} else {
			logFinding({ probe: 'c-auto-pk-POST', verdict: 'CORRECT-PARTIAL', detail: `POST 2xx but PK not in response body — auto-PK may still be assigned, response body=${JSON.stringify(post.body)}` });
		}

		// Verify via ops sql that at least one AutoTimestamp record with payload='auto-pk-test' exists
		const sql = await sqlQuery(client, `SELECT id FROM data.AutoTimestamp WHERE payload = 'auto-pk-test'`);
		ok(sql.status === 200, `SQL check should 200; got ${sql.status}`);
		ok(Array.isArray(sql.body) && sql.body.length >= 1, `At least one auto-pk record should exist; got ${JSON.stringify(sql.body)}`);
		const pkRow = sql.body[0];
		ok(pkRow.id && typeof pkRow.id === 'string' && pkRow.id.length > 0, `Auto-generated PK should be a non-empty string; got ${JSON.stringify(pkRow.id)}`);
		logFinding({ probe: 'c-auto-pk-SQL', verdict: 'CORRECT', detail: `auto-PK persisted, type=string, id=${pkRow.id}` });
	});

	// (d): @createdTime preserved on PATCH (not overwritten with new timestamp)
	test('(d) @createdTime preserved on PATCH: original value retained, @updatedTime bumped', async () => {
		// Insert with known id
		const put = await restPut(client, '/AutoTimestamp/at-patch-1', { payload: 'initial' });
		ok(put.status === 200 || put.status === 204, `Initial PUT should succeed; got ${put.status}`);

		const g0 = await restGet(client, '/AutoTimestamp/at-patch-1');
		strictEqual(g0.status, 200, 'GET should succeed');
		const createdAt0 = g0.body.createdAt as number;
		const updatedAt0 = g0.body.updatedAt as number;
		ok(typeof createdAt0 === 'number', `createdAt should be a number after insert; got ${createdAt0}`);

		await sleep(50); // ensure timestamp difference is detectable

		// PATCH — update payload only
		const patch = await restPatch(client, '/AutoTimestamp/at-patch-1', { payload: 'updated' });
		ok(patch.status === 200 || patch.status === 204, `PATCH should succeed; got ${patch.status} body=${JSON.stringify(patch.body)}`);

		const g1 = await restGet(client, '/AutoTimestamp/at-patch-1');
		const createdAt1 = g1.body.createdAt as number;
		const updatedAt1 = g1.body.updatedAt as number;

		const createdPreserved = createdAt1 === createdAt0;
		const updatedBumped = typeof updatedAt1 === 'number' && updatedAt1 >= updatedAt0;

		if (createdPreserved && updatedBumped) {
			logFinding({ probe: 'd-PATCH-createdTime-preserved', verdict: 'CORRECT', detail: `createdAt preserved=${createdAt0}, updatedAt bumped ${updatedAt0}→${updatedAt1}` });
		} else {
			logFinding({
				probe: 'd-PATCH-createdTime-preserved',
				verdict: 'FOOTGUN',
				detail: `createdAt changed? ${createdAt0}→${createdAt1} (preserved=${createdPreserved}), updatedAt ${updatedAt0}→${updatedAt1} (bumped=${updatedBumped})`,
			});
		}
		ok(createdPreserved, `@createdTime should be preserved on PATCH; was ${createdAt0}, got ${createdAt1}`);
		ok(updatedBumped, `@updatedTime should be bumped on PATCH; was ${updatedAt0}, got ${updatedAt1}`);
	});

	// (e): Caller attempt to overwrite @createdTime on PATCH is silently ignored (original retained)
	test('(e) PATCH with explicit createdTime value: server overrides to retain original', async () => {
		const put = await restPut(client, '/AutoTimestamp/at-override-1', { payload: 'base' });
		ok(put.status === 200 || put.status === 204, `Initial PUT should succeed`);

		const g0 = await restGet(client, '/AutoTimestamp/at-override-1');
		const createdAtOriginal = g0.body.createdAt as number;

		await sleep(50);

		// Attempt to set a bogus createdAt (far in the future)
		const bogusCreatedAt = Date.now() + 99_999_999;
		const patch = await restPatch(client, '/AutoTimestamp/at-override-1', { payload: 'changed', createdAt: bogusCreatedAt });
		ok(patch.status === 200 || patch.status === 204, `PATCH with explicit createdAt should not 400; got ${patch.status}`);

		const g1 = await restGet(client, '/AutoTimestamp/at-override-1');
		const createdAtAfter = g1.body.createdAt as number;

		if (createdAtAfter === createdAtOriginal) {
			logFinding({ probe: 'e-PATCH-override-createdTime', verdict: 'CORRECT', detail: `@createdTime override ignored; original ${createdAtOriginal} retained` });
		} else if (createdAtAfter === bogusCreatedAt) {
			logFinding({ probe: 'e-PATCH-override-createdTime', verdict: 'FOOTGUN', detail: `@createdTime was OVERWRITEABLE via PATCH; new value=${createdAtAfter} (bogus)` });
		} else {
			logFinding({ probe: 'e-PATCH-override-createdTime', verdict: 'FOOTGUN', detail: `@createdTime changed unexpectedly: orig=${createdAtOriginal} after=${createdAtAfter}` });
		}
		// Note: per source code analysis line 1912, on partial update (PATCH) with entry?.value set,
		// createdAt is only restored if fullUpdate OR if recordUpdate[createdTimeProperty.name] is truthy.
		// When caller sends createdAt in the PATCH body, it IS truthy → code runs entry?.value[createdTimeProperty.name]
		// i.e., it restores from existing record. So the override SHOULD be silently ignored (correct behavior).
		// This test verifies that expectation.
		ok(createdAtAfter === createdAtOriginal, `@createdTime override via PATCH should be ignored; original=${createdAtOriginal}, got=${createdAtAfter}`);
	});

	// (f): @sealed table + @createdTime: field omitted on insert auto-assigned; unknown field rejected
	test('(f) @sealed table: @createdTime auto-assigned on insert; unknown field rejected', async () => {
		const t0 = Date.now();
		const put = await restPut(client, '/SealedTimestamp/st-1', { payload: 'sealed-test' });
		const t1 = Date.now();
		ok(put.status === 200 || put.status === 204, `PUT on sealed table (omitting auto-fields) should succeed; got ${put.status} body=${JSON.stringify(put.body)}`);

		const g = await restGet(client, '/SealedTimestamp/st-1');
		strictEqual(g.status, 200, `GET should 200`);
		const { createdAt, updatedAt } = g.body;

		// createdAt is String type on SealedTimestamp
		const createdIsISO = typeof createdAt === 'string' && createdAt.length > 0 && !isNaN(Date.parse(createdAt));
		const updatedIsISO = typeof updatedAt === 'string' && updatedAt.length > 0 && !isNaN(Date.parse(updatedAt));

		logFinding({
			probe: 'f-sealed-createdTime',
			verdict: createdIsISO && updatedIsISO ? 'CORRECT' : 'FOOTGUN',
			detail: `createdAt=${createdAt} (ISO=${createdIsISO}), updatedAt=${updatedAt} (ISO=${updatedIsISO}) on @sealed insert`,
		});
		ok(createdIsISO, `@createdTime (String type) on @sealed table should be auto-assigned ISO string; got ${createdAt}`);
		ok(updatedIsISO, `@updatedTime (String type) on @sealed table should be auto-assigned ISO string; got ${updatedAt}`);

		// Now try inserting an undeclared field — @sealed should reject it
		const putUnknown = await restPut(client, '/SealedTimestamp/st-bogus', { payload: 'x', unknownField: 'boom' });
		const sealedRejects = putUnknown.status === 400;
		logFinding({
			probe: 'f-sealed-unknown-field',
			verdict: sealedRejects ? 'CORRECT' : 'FOOTGUN',
			detail: `PUT with undeclared field on @sealed → ${putUnknown.status} (expected 400); body=${JSON.stringify(putUnknown.body)}`,
		});
		ok(sealedRejects, `@sealed table should reject undeclared fields with 400; got ${putUnknown.status}`);
	});

	// (g): No @default directive — omitting a non-required field leaves it absent (feature gap)
	test('(g) No @default directive: omitted optional field is absent (not defaulted)', async () => {
		// Insert PlainTable record with only id — omit status and count
		const put = await restPut(client, '/PlainTable/pt-1', { id: 'pt-1' });
		ok(put.status === 200 || put.status === 204, `PUT with only id should succeed; got ${put.status}`);

		const g = await restGet(client, '/PlainTable/pt-1');
		strictEqual(g.status, 200);

		const hasStatus = 'status' in g.body;
		const hasCount = 'count' in g.body;

		if (!hasStatus && !hasCount) {
			logFinding({ probe: 'g-no-default-directive', verdict: 'GAP', detail: `Harper has NO @default directive: omitted optional fields are absent (null/undefined), not defaulted. Feature gap, not a silent-ignore (like D-151).` });
		} else {
			logFinding({ probe: 'g-no-default-directive', verdict: 'FOOTGUN', detail: `Unexpected: omitted fields appeared in body=${JSON.stringify(g.body)}` });
		}
		// GAP is expected and correct characterization; test passes unconditionally for this probe
		// since we're documenting a feature gap, not asserting Harper does default values
		console.log(`g: status=${g.body.status} (present=${hasStatus}), count=${g.body.count} (present=${hasCount})`);
	});

	// (h): Required (non-null !) field omitted on insert → 400
	test('(h) Required non-null field: omit on insert → 400 (no default satisfies required)', async () => {
		const put = await restPut(client, '/RequiredField/rf-1', { optional: 'hello' }); // omit 'name' (required String!)
		const requiredRejected = put.status === 400 || put.status === 422;
		logFinding({
			probe: 'h-required-field-omit',
			verdict: requiredRejected ? 'CORRECT' : 'FOOTGUN',
			detail: `PUT omitting required 'name' field → ${put.status}; body=${JSON.stringify(put.body)}`,
		});
		ok(requiredRejected, `Omitting a required (non-null) field should 400/422; got ${put.status} body=${JSON.stringify(put.body)}`);
	});

	// (i): Surface parity — ops insert also auto-assigns @createdTime/@updatedTime
	test('(i) Ops insert: @createdTime and @updatedTime auto-assigned via ops API', async () => {
		const t0 = Date.now();
		const ins = await opsInsert(client, 'AutoTimestamp', [{ id: 'at-ops-1', payload: 'ops-insert' }]);
		const t1 = Date.now();
		ok(ins.status === 200 || ins.status === 204, `ops insert should succeed; got ${ins.status} body=${JSON.stringify(ins.body)}`);

		const g = await restGet(client, '/AutoTimestamp/at-ops-1');
		strictEqual(g.status, 200, `GET after ops insert should 200`);

		const { createdAt, updatedAt } = g.body;
		const createdOk = typeof createdAt === 'number' && createdAt >= t0 && createdAt <= t1 + 1000;
		const updatedOk = typeof updatedAt === 'number' && updatedAt >= t0 && updatedAt <= t1 + 1000;

		logFinding({
			probe: 'i-ops-insert-auto-fields',
			verdict: createdOk && updatedOk ? 'CORRECT' : 'FOOTGUN',
			detail: `ops insert: createdAt=${createdAt} (ok=${createdOk}), updatedAt=${updatedAt} (ok=${updatedOk})`,
		});
		ok(createdOk, `ops insert: @createdTime should be auto-set; got createdAt=${createdAt}`);
		ok(updatedOk, `ops insert: @updatedTime should be auto-set; got updatedAt=${updatedAt}`);
	});

	// (i-sql): SQL INSERT also auto-assigns @createdTime/@updatedTime
	test('(i-sql) SQL INSERT: @createdTime and @updatedTime auto-assigned', async () => {
		const t0 = Date.now();
		const ins = await sqlQuery(client, `INSERT INTO data.AutoTimestamp (id, payload) VALUES ('at-sql-1', 'sql-insert')`);
		const t1 = Date.now();
		ok(ins.status === 200, `SQL INSERT should succeed; got ${ins.status} body=${JSON.stringify(ins.body)}`);

		const g = await restGet(client, '/AutoTimestamp/at-sql-1');
		strictEqual(g.status, 200, `GET after SQL INSERT should 200`);

		const { createdAt, updatedAt } = g.body;
		const createdOk = typeof createdAt === 'number' && createdAt >= t0 && createdAt <= t1 + 1000;
		const updatedOk = typeof updatedAt === 'number' && updatedAt >= t0 && updatedAt <= t1 + 1000;

		logFinding({
			probe: 'i-sql-insert-auto-fields',
			verdict: createdOk && updatedOk ? 'CORRECT' : 'FOOTGUN',
			detail: `SQL INSERT: createdAt=${createdAt} (ok=${createdOk}), updatedAt=${updatedAt} (ok=${updatedOk})`,
		});
		ok(createdOk, `SQL INSERT: @createdTime should be auto-set; got createdAt=${createdAt}`);
		ok(updatedOk, `SQL INSERT: @updatedTime should be auto-set; got updatedAt=${updatedAt}`);
	});

	// PUT (full replace) also re-stamps @updatedTime and preserves @createdTime
	test('(bonus) PUT full-replace: @updatedTime re-stamped, @createdTime preserved', async () => {
		const put0 = await restPut(client, '/AutoTimestamp/at-fullput-1', { payload: 'v1' });
		ok(put0.status === 200 || put0.status === 204, `First PUT should succeed`);

		const g0 = await restGet(client, '/AutoTimestamp/at-fullput-1');
		const createdAt0 = g0.body.createdAt as number;

		await sleep(50);

		// Full PUT replace (omit createdAt — it should be restored from existing record)
		const put1 = await restPut(client, '/AutoTimestamp/at-fullput-1', { payload: 'v2' });
		ok(put1.status === 200 || put1.status === 204, `Second PUT should succeed`);

		const g1 = await restGet(client, '/AutoTimestamp/at-fullput-1');
		const createdAt1 = g1.body.createdAt as number;
		const updatedAt1 = g1.body.updatedAt as number;

		const createdPreserved = createdAt1 === createdAt0;
		// Per source: fullUpdate → recordUpdate[createdTimeProperty.name] is set from entry.value
		// So createdAt should be preserved on full PUT too
		logFinding({
			probe: 'bonus-full-PUT-createdTime',
			verdict: createdPreserved ? 'CORRECT' : 'FOOTGUN',
			detail: `full PUT: createdAt ${createdAt0}→${createdAt1} (preserved=${createdPreserved}), updatedAt=${updatedAt1}`,
		});
		ok(createdPreserved, `@createdTime should be preserved on full PUT replace; was ${createdAt0}, got ${createdAt1}`);
	});
});
