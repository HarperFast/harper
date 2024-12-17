import request from 'supertest';
import assert from "node:assert";
import {envUrl} from "../config/envConfig.js";

export async function insert(schemaName, tableName, records, expectedMessage) {
    await request(envUrl)
        .post('')
        .send({
            operation: 'insert',
            schema: schemaName,
            table: tableName,
            records: records
        })
        .expect((r) => {
            const body = JSON.stringify(r.body);
            assert.ok(body.includes('inserted'));
            if(expectedMessage)
                assert.ok(body.includes(expectedMessage));
        })
        .expect(200)
}