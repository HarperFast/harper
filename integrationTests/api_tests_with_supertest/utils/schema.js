import request from 'supertest';
import  assert from "node:assert";

export async function create_schema(url, schemaName) {
    await request(url)
        .post('')
        .send({
            operation: 'create_schema',
            schema: schemaName
        })
        .expect((r) => {
            const body = JSON.stringify(r.body);
            assert.ok(body.includes('successfully created'));
            assert.ok(body.includes(schemaName));
        })
        .expect(200)
}

export async function drop_schema(url, schemaName, failTest) {
    await request(url)
        .post('')
        .send({
            operation: 'drop_schema',
            schema: schemaName
        })
        .expect((r) => {
            if(failTest) {
                const body = JSON.stringify(r.body);
                assert.ok(body.includes('successfully deleted'));
                assert.ok(body.includes(schemaName));
                assert.equal(r.status, 200);
            }
        })
}

export async function check_table_in_schema(url, schemaName, checkTableName) {
    await request(url)
        .post('')
        .send({
            operation: 'describe_schema',
            schema: schemaName
        })
        .expect((r) => {
            const jsonData = r.body;
            let count = 0;
            Object.values(jsonData).forEach(table => {
                if (table.schema != schemaName || table.name != checkTableName) {
                    count++;
                }
            })
            assert.equal(count, 0);
            // alternative check 2
            // jsonData[checkTableName].schema == schemaName && jsonData[checkTableName].name == checkTableName;
        })
        .expect(200)
}