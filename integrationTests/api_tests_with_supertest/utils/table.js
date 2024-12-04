import request from 'supertest';
import assert from "node:assert";

export async function create_table(url, databaseName, tableName, hashAttribute ) {
    await request(url)
        .post('')
        .send({
            operation: 'create_table',
            database: databaseName,
            table: tableName,
            hash_attribute: hashAttribute
        })
        .expect((r) => {
            const body = JSON.stringify(r.body);
            assert.ok(body.includes('successfully created'));
            assert.ok(body.includes(tableName));
        })
        .expect(200)
}

export async function drop_table(url, schemaName, tableName, failTest) {
    await request(url)
        .post('')
        .send({
            operation: 'drop_table',
            schema: schemaName,
            table: tableName
        })
        .expect((r) => {
            if(failTest) {
                const body = JSON.stringify(r.body);
                assert.ok(body.includes('successfully deleted'));
                assert.ok(body.includes(tableName));
                assert.equal(r.status, 200);
            }
        })
}