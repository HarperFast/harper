import assert from 'node:assert/strict';
import { req } from './request.mjs';

export function createTable(databaseName, tableName, hashAttribute) {
	return req()
		.send({
			operation: 'create_table',
			database: databaseName,
			table: tableName,
			hash_attribute: hashAttribute,
		})
		.expect((r) => {
			const body = JSON.stringify(r.body);
			assert.ok(body.includes('successfully created'), r.text);
			assert.ok(body.includes(tableName), r.text);
		})
		.expect(200);
}

export function dropTable(schemaName, tableName, failTest) {
	return req()
		.send({
			operation: 'drop_table',
			schema: schemaName,
			table: tableName,
		})
		.expect((r) => {
			if (failTest) {
				const body = JSON.stringify(r.body);
				assert.ok(body.includes('successfully deleted'), r.text);
				assert.ok(body.includes(tableName), r.text);
				assert.equal(r.status, 200, r.text);
			}
		});
}
