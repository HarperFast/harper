/**
 * risk-query component integration test.
 *
 * Deploys risk-query and verifies the REST API:
 * shorthand field mapping, upsert, edge cases, and deletion.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';

import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '@harperfast/integration-testing';

suite('Component: risk-query', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);

		// Deploy risk-query from GitHub
		const body = await sendOperation(ctx.harper, {
			operation: 'deploy_component',
			project: 'risk-query',
			package: 'https://github.com/HarperFast/risk-query',
			restart: true,
		});
		deepStrictEqual(body, { message: 'Successfully deployed: risk-query, restarting Harper' });

		// Poll until the component is ready
		const deadline = Date.now() + 30_000;
		while (true) {
			try {
				const check = await fetch(`${ctx.harper.httpURL}/RisqTable/`);
				if (check.status === 200) break;
			} catch {
				// server not yet accepting connections
			}
			if (Date.now() > deadline) throw new Error('Timed out waiting for risk-query to be ready after deploy');
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('insert via PUT /risq with shorthand fields', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/risq/ci-test-001`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ di: 'device-abc', d: 'allow', r: 60 }),
		});
		strictEqual(res.status, 204);
	});

	test('GET /risq returns expanded field names', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/risq/ci-test-001`);
		strictEqual(res.status, 200);
		const body = await res.json();
		strictEqual(body.correlationId, 'ci-test-001');
		strictEqual(body.deviceId, 'device-abc');
		strictEqual(body.decision, 'allow');
		strictEqual(body.riskScore, 60);
	});

	test('GET /RisqTable/:id returns same data as /risq/:id', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/RisqTable/ci-test-001`);
		strictEqual(res.status, 200);
		const body = await res.json();
		strictEqual(body.correlationId, 'ci-test-001');
		strictEqual(body.deviceId, 'device-abc');
		strictEqual(body.decision, 'allow');
		strictEqual(body.riskScore, 60);
	});

	test('GET /RisqTable/ returns array of records', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/RisqTable/`);
		strictEqual(res.status, 200);
		const body = await res.json();
		ok(Array.isArray(body), 'expected array');
		ok(body.length >= 1, 'expected at least 1 record');
	});

	test('upsert overwrites existing record', async () => {
		// insert
		await fetch(`${ctx.harper.httpURL}/risq/ci-test-002`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ di: 'original-device', d: 'allow', r: 10 }),
		});

		// upsert with new values
		const upsertRes = await fetch(`${ctx.harper.httpURL}/risq/ci-test-002`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ di: 'updated-device', d: 'deny', r: 99 }),
		});
		strictEqual(upsertRes.status, 204);

		// verify
		const getRes = await fetch(`${ctx.harper.httpURL}/risq/ci-test-002`);
		const body = await getRes.json();
		strictEqual(body.deviceId, 'updated-device');
		strictEqual(body.decision, 'deny');
		strictEqual(body.riskScore, 99);
	});

	test('PUT with missing fields omits them from response', async () => {
		await fetch(`${ctx.harper.httpURL}/risq/ci-edge-missing`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ di: 'only-device' }),
		});

		const res = await fetch(`${ctx.harper.httpURL}/risq/ci-edge-missing`);
		const body = await res.json();
		strictEqual(body.correlationId, 'ci-edge-missing');
		strictEqual(body.deviceId, 'only-device');
		strictEqual(body.decision, undefined, 'decision should be absent');
		strictEqual(body.riskScore, undefined, 'riskScore should be absent');
	});

	test('PUT with empty body stores only correlationId', async () => {
		await fetch(`${ctx.harper.httpURL}/risq/ci-edge-empty`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});

		const res = await fetch(`${ctx.harper.httpURL}/risq/ci-edge-empty`);
		const body = await res.json();
		strictEqual(body.correlationId, 'ci-edge-empty');
		strictEqual(body.deviceId, undefined, 'deviceId should be absent');
		strictEqual(body.decision, undefined, 'decision should be absent');
		strictEqual(body.riskScore, undefined, 'riskScore should be absent');
	});

	test('GET nonexistent record returns null', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/risq/does-not-exist-xyz`);
		const body = await res.json();
		strictEqual(body, null);
	});

	// TODO: returns 200 in dev mode, 401 on Fabric. Needs auth config investigation.
	// test('GET without auth returns 401', async () => {
	// 	const res = await fetch(`${ctx.harper.httpURL}/risq/ci-test-001`);
	// 	strictEqual(res.status, 401);
	// });

	test('DELETE removes record and GET returns null', async () => {
		// insert a record to delete
		await fetch(`${ctx.harper.httpURL}/risq/ci-test-delete`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ di: 'to-delete', d: 'allow', r: 1 }),
		});

		// confirm exists
		const existsRes = await fetch(`${ctx.harper.httpURL}/risq/ci-test-delete`);
		const existsBody = await existsRes.json();
		ok(existsBody !== null, 'record should exist before delete');

		// delete
		const deleteRes = await fetch(`${ctx.harper.httpURL}/risq/ci-test-delete`, {
			method: 'DELETE',
		});
		const deleteBody = await deleteRes.json();
		strictEqual(deleteBody, true);

		// confirm gone
		const goneRes = await fetch(`${ctx.harper.httpURL}/risq/ci-test-delete`);
		const goneBody = await goneRes.json();
		strictEqual(goneBody, null);
	});
});
