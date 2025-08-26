import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { req } from '../utils/request.js';

describe('13. System Information', () => {
	//System Information Folder

	it('Get all System Information',  () => {
		return req()
			.send({ operation: 'system_information' })
			.expect((r) => {
				let attributes = ['system', 'time', 'cpu', 'memory', 'disk', 'network', 'harperdb_processes', 'table_size'];
				attributes.forEach((attribute) => {
					assert.notEqual(r.body[attribute],undefined, r.text);
				});
			})
			.expect(200);
	});

	it('Get some System Information (time, memory)',  () => {
		return req()
			.send({ operation: 'system_information', attributes: ['memory', 'time'] })
			.expect((r) => {
				assert.ok(!r.body.system, r.text);
				assert.ok(!r.body.cpu, r.text);
				assert.ok(!r.body.disk, r.text);
				assert.ok(!r.body.network, r.text);
				assert.ok(!r.body.harperdb_processes, r.text);
				assert.ok(!r.body.table_size, r.text);
				assert.ok(r.body.hasOwnProperty('time'), r.text);
				assert.ok(r.body.hasOwnProperty('memory'), r.text);
				assert.ok(r.body.time.hasOwnProperty('current'), r.text);
				assert.ok(r.body.time.hasOwnProperty('uptime'), r.text);
				assert.ok(r.body.time.hasOwnProperty('timezone'), r.text);
				assert.ok(r.body.time.hasOwnProperty('timezoneName'), r.text);
				assert.ok(r.body.memory.hasOwnProperty('total'), r.text);
				assert.ok(r.body.memory.hasOwnProperty('free'), r.text);
				assert.ok(r.body.memory.hasOwnProperty('used'), r.text);
				assert.ok(r.body.memory.hasOwnProperty('active'), r.text);
				assert.ok(r.body.memory.hasOwnProperty('swaptotal'), r.text);
				assert.ok(r.body.memory.hasOwnProperty('swapused'), r.text);
				assert.ok(r.body.memory.hasOwnProperty('swapfree'), r.text);
				assert.ok(r.body.memory.hasOwnProperty('available'), r.text);
			})
			.expect(200);
	});
});
