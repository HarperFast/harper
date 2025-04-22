import assert from 'node:assert/strict';
import { req } from './request.js';

 export function insert(schemaName, tableName, records, expectedMessage) {
    return req()
        .send({
            operation: 'insert',
            schema: schemaName,
            table: tableName,
            records: records
        })
        .expect((r) => {
            const body = JSON.stringify(r.body);
            assert.ok(body.includes('inserted'), r.text);
            if (expectedMessage)
                assert.ok(body.includes(expectedMessage), r.text);
        })
        .expect(200)
}