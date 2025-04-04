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
					assert.ok(r.body[attribute] !== undefined);
				});
			})
			.expect(200);
	});

	it('Get some System Information (time, memory)', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'system_information', attributes: ['memory', 'time'] })
			.expect((r) => assert.ok(!r.body.system))
			.expect((r) => assert.ok(!r.body.cpu))
			.expect((r) => assert.ok(!r.body.disk))
			.expect((r) => assert.ok(!r.body.network))
			.expect((r) => assert.ok(!r.body.harperdb_processes))
			.expect((r) => assert.ok(!r.body.table_size))
			.expect((r) => assert.ok(r.body.hasOwnProperty('time')))
			.expect((r) => assert.ok(r.body.hasOwnProperty('memory')))
			.expect((r) => assert.ok(r.body.time.hasOwnProperty('current')))
			.expect((r) => assert.ok(r.body.time.hasOwnProperty('uptime')))
			.expect((r) => assert.ok(r.body.time.hasOwnProperty('timezone')))
			.expect((r) => assert.ok(r.body.time.hasOwnProperty('timezoneName')))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('total')))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('free')))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('used')))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('active')))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('swaptotal')))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('swapused')))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('swapfree')))
			.expect((r) => assert.ok(r.body.memory.hasOwnProperty('available')))
			.expect(200);
	});
});
