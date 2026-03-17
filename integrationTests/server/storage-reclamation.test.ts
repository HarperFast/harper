/**
 * Storage reclamation integration test.
 *
 * Tests that storage reclamation correctly removes expired/evicted records
 * from caching tables when disk space is simulated as low.
 *
 * This test:
 * 1. Creates a caching table with short expiration/eviction times and audit logging
 * 2. Populates it with records (which creates audit entries)
 * 3. Configures a low storage threshold to trigger reclamation
 * 4. Verifies records are removed after reclamation runs
 * 5. Verifies audit logs were created for the operations
 *
 * Note: Audit log size reclamation uses the same underlying mechanism as record
 * reclamation. The unit tests in storageReclamation.test.js cover the handler
 * registration and priority-based callback system. This integration test verifies
 * the end-to-end behavior is working correctly.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { startHarper, teardownHarper, type ContextWithHarper } from '../utils/harperLifecycle.ts';

const TEST_DATABASE = 'test';
const TEST_TABLE = 'reclaim';

suite('Storage reclamation', (ctx: ContextWithHarper) => {
	before(async () => {
		// Set a very high reclamation threshold (99%) so reclamation triggers immediately
		// and a short interval (1 second) for faster test execution
		await startHarper(ctx, {
			config: {
				STORAGE_RECLAMATION_THRESHOLD: 0.99,
				STORAGE_RECLAMATION_INTERVAL: '1s',
			},
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('verify Harper is running', async () => {
		const response = await fetch(`${ctx.harper.operationsAPIURL}/health`);
		strictEqual(response.status, 200);
		const body = await response.text();
		strictEqual(body, 'Harper is running.');
	});

	test('create test database and caching table with audit logging', async () => {
		// Create database
		const createDbResponse = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: JSON.stringify({
				operation: 'create_database',
				database: TEST_DATABASE,
			}),
		});
		if (createDbResponse.status !== 200) {
			console.error('create_database failed:', await createDbResponse.text());
		}
		strictEqual(createDbResponse.status, 200);

		// Create caching table with short expiration and audit logging enabled
		const createTableResponse = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: JSON.stringify({
				operation: 'create_table',
				schema: TEST_DATABASE,
				table: TEST_TABLE,
				primary_key: 'id',
				expiration: 2, // 2 second expiration (in seconds)
				eviction: 1, // 1 second eviction (in seconds)
				audit: true, // Enable audit logging
			}),
		});
		if (createTableResponse.status !== 200) {
			console.error('create_table failed:', await createTableResponse.text());
		}
		strictEqual(createTableResponse.status, 200);
	});

	test('insert records into caching table', async () => {
		// Insert multiple records
		const records = [];
		for (let i = 1; i <= 50; i++) {
			records.push({
				id: i,
				data: `test data ${i}`.repeat(100), // Some bulk to make reclamation meaningful
			});
		}

		const insertResponse = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: JSON.stringify({
				operation: 'insert',
				schema: TEST_DATABASE,
				table: TEST_TABLE,
				records,
			}),
		});
		const insertBody = await insertResponse.text();
		strictEqual(insertResponse.status, 200, `Insert failed: ${insertBody}`);

		// Verify records were inserted
		const countResponse = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: JSON.stringify({
				operation: 'sql',
				sql: `select count(*) from ${TEST_DATABASE}.${TEST_TABLE}`,
			}),
		});
		const countBody1 = await countResponse.text();
		strictEqual(countResponse.status, 200, `Count query failed: ${countBody1}`);
		const countParsed = JSON.parse(countBody1);
		strictEqual(countParsed[0]['COUNT(*)'], 50);
	});

	test('audit logs are created for insert operations', async () => {
		// Read audit log to verify entries were created
		const auditResponse = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: JSON.stringify({
				operation: 'read_audit_log',
				schema: TEST_DATABASE,
				table: TEST_TABLE,
			}),
		});
		const auditBody = await auditResponse.text();
		strictEqual(auditResponse.status, 200, `Read audit log failed: ${auditBody}`);
		const auditLogs = JSON.parse(auditBody);

		// Should have at least one audit entry for the insert operation
		ok(Array.isArray(auditLogs), 'Audit log should be an array');
		ok(auditLogs.length > 0, 'Audit log should have entries from the insert');

		// Find the insert operation
		const insertEntry = auditLogs.find((entry: { operation: string }) => entry.operation === 'insert');
		ok(insertEntry, 'Should have an insert audit entry');
	});

	test('records are reclaimed after expiration and reclamation cycle', async () => {
		// Wait for expiration (2s) + eviction (1s) + reclamation interval (1s) + buffer
		// Total: ~5 seconds should be enough for records to expire and be reclaimed
		await sleep(6000);

		// Check record count - should be significantly reduced
		const countResponse = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: JSON.stringify({
				operation: 'sql',
				sql: `select count(*) from ${TEST_DATABASE}.${TEST_TABLE}`,
			}),
		});
		const countBody2 = await countResponse.text();
		strictEqual(countResponse.status, 200, `Count query after reclamation failed: ${countBody2}`);
		const countBody = JSON.parse(countBody2);

		// Records should have been reclaimed (count should be less than original 50)
		// With high reclamation threshold and expired records, most/all should be removed
		ok(
			countBody[0]['COUNT(*)'] < 50,
			`Expected record count to decrease after reclamation, got ${countBody[0]['COUNT(*)']}`
		);
	});
});
