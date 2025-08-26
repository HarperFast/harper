import assert from 'node:assert/strict';
import { req } from './request.js';

 export function searchByHash(schemaName, tableName, hashAttribute, hashValues, getAttributes, expectedMessage) {
    return req()
        .send({
            operation: 'search_by_hash',
            schema: schemaName,
            table: tableName,
            hash_attribute: hashAttribute,
            hash_values: hashValues,
            get_attributes: getAttributes
        })
        .expect((r) => {
            const body = JSON.stringify(r.body);
            if (expectedMessage)
                assert.ok(body.includes(expectedMessage), r.text);
        })
        .expect(200)
}