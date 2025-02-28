import request from 'supertest';
import assert from "node:assert";
import {envUrl, headers} from "../config/envConfig.js";

export async function searchByHash(schemaName, tableName, hashAttribute, hashValues, getAttributes, expectedMessage) {
    await request(envUrl)
        .post('')
        .set(headers)
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
                assert.ok(body.includes(expectedMessage));
        })
        .expect(200)
}