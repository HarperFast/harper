/**
 * This tests that transaction log replay works on crash. There is a bunch of data written to the system
 * database, so replay needs to work for harper to startup.
 */
import { suite, test, before, after } from 'node:test';
import {
	startHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
	killHarper,
} from '../utils/harperLifecycle.ts';
import { ok } from 'node:assert';
import { join } from 'node:path';

suite('Start 4.x server and test upgrade', (ctx: ContextWithHarper) => {
	before(async () => {
		const legacyPath = process.env.HARPER_LEGACY_VERSION_PATH;
		if (!legacyPath) return;
		await startHarper(ctx, {
			config: {},
			env: {
				TC_AGREEMENT: 'yes',
				REPLICATION_HOSTNAME: 'localhost',
			},
			harperBinPath: join(legacyPath, 'bin', 'harperdb.js'),
		});
		await sendOperation(ctx.harper, {
			operation: 'create_table',
			table: 'test',
			primary_key: 'id',
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'name', type: 'String' },
			],
		});
		for (let i = 0; i < 10; i++) {
			await sendOperation(ctx.harper, {
				operation: 'upsert',
				table: 'test',
				records: [{ id: 'id-' + i, name: 'test data ' + Math.random() }],
			});
		}
		for (let i = 0; i < 5; i++) {
			await sendOperation(ctx.harper, {
				operation: 'upsert',
				table: 'test',
				records: [{ id: 'id-' + Math.floor(Math.random() * 10), name: 'test data ' + Math.random() }],
			});
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('upgrade and start', async () => {
		await killHarper(ctx); // kill old 4.x harper
		await startHarper(ctx, { config: {}, env: {} }); // start on v5
		let response = await sendOperation(ctx.harper, {
			operation: 'search_by_conditions',
			table: 'test',
			conditions: [{ attribute: 'id', comparator: 'greater_than', value: 'id-4' }],
		});
		ok(response.length > 4);
		response = await sendOperation(ctx.harper, {
			operation: 'read_audit_log',
			schema: 'data',
			table: 'test',
		});
		ok(response.length > 10);
	});
});
