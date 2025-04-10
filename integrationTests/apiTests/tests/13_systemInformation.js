import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { envUrl, headers } from '../config/envConfig.js';

describe('13. System Information', () => {
	//System Information Folder

	it('Get all System Information', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'system_information' })
			.expect((r) => {
				let attributes = ['system', 'time', 'cpu', 'memory', 'disk', 'network', 'harperdb_processes', 'table_size'];
				attributes.forEach((attribute) => {
					assert.ok(r.body[attribute] !== undefined, r.text);
				});
			})
			.expect(200);
	});

	it('Get some System Information (time, memory)', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'system_information', attributes: ['memory', 'time'] })
			.expect((r) => assert.ok(!r.body.system, r.text))
			.expect((r) => assert.ok(!r.body.cpu, r.text))
			.expect((r) => assert.ok(!r.body.disk, r.text))
			.expect((r) => assert.ok(!r.body.network, r.text))
			.expect((r) => assert.ok(!r.body.harperdb_processes, r.text))
			.expect((r) => assert.ok(!r.body.table_size, r.text))
			.expect((r) => assert.ok(r.body.hasOwnProperty('time'), r.text))
			.expect((r) => assert.ok(r.body.hasOwnProperty('memory'), r.text))
			.expect((r) => assert.ok(r.body.time.hasOwnProperty('current'), r.text))
			.expect((r) => assert.ok(r.body.time.hasOwnProperty('uptime'), r.text))
			.expect((r) => assert.ok(r.body.time.hasOwnProperty('timezone'), r.text))
			.expect((r) => assert.ok(r.body.time.hasOwnProperty('timezoneName'), r.text))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('total'), r.text))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('free'), r.text))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('used'), r.text))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('active'), r.text))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('swaptotal'), r.text))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('swapused'), r.text))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('swapfree'), r.text))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('available'), r.text))
			.expect(200);
	});
});
