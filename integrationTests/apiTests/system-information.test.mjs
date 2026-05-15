/**
 * System Information API integration tests.
 *
 * Pilot conversion of legacy `apiTests/tests/13_systemInformation.mjs` to the
 * @harperfast/integration-testing framework. Each test file owns a throwaway
 * Harper instance via startHarper/teardownHarper, so the suite is independent,
 * hermetic, and safe to run concurrently with other test files.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';

suite('System Information', (ctx) => {
	let client;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('returns all attributes by default', async () => {
		const response = await client.req().send({ operation: 'system_information' }).expect(200);
		const attributes = ['system', 'time', 'cpu', 'memory', 'disk', 'network', 'harperdb_processes', 'table_size'];
		for (const attribute of attributes) {
			assert.notEqual(response.body[attribute], undefined, `missing attribute "${attribute}": ${response.text}`);
		}
	});

	test('respects requested attributes filter', async () => {
		const response = await client
			.req()
			.send({ operation: 'system_information', attributes: ['memory', 'time'] })
			.expect(200);

		const body = response.body;
		assert.ok(!body.system, response.text);
		assert.ok(!body.cpu, response.text);
		assert.ok(!body.disk, response.text);
		assert.ok(!body.network, response.text);
		assert.ok(!body.harperdb_processes, response.text);
		assert.ok(!body.table_size, response.text);

		assert.ok(Object.prototype.hasOwnProperty.call(body, 'time'), response.text);
		assert.ok(Object.prototype.hasOwnProperty.call(body, 'memory'), response.text);

		for (const field of ['current', 'uptime', 'timezone', 'timezoneName']) {
			assert.ok(Object.prototype.hasOwnProperty.call(body.time, field), `time.${field} missing: ${response.text}`);
		}
		for (const field of ['total', 'free', 'used', 'active', 'swaptotal', 'swapused', 'swapfree', 'available']) {
			assert.ok(Object.prototype.hasOwnProperty.call(body.memory, field), `memory.${field} missing: ${response.text}`);
		}
	});
});
