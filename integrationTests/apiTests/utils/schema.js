import request from 'supertest';
import assert from "node:assert";
import {envUrl, headers} from "../config/envConfig.js";

export async function createSchema(schemaName) {
    await request(envUrl)
        .post('')
        .set(headers)
        .send({
            operation: 'create_schema',
            schema: schemaName
        })
        .expect((r) => {
            const body = JSON.stringify(r.body);
            assert.ok(body.includes('successfully created'), r.text);
            assert.ok(body.includes(schemaName), r.text);
        })
        .expect(200)
}

export async function dropSchema(schemaName, failTest) {
    await request(envUrl)
        .post('')
        .set(headers)
        .send({
            operation: 'drop_schema',
            schema: schemaName
        })
        .expect((r) => {
            if (failTest) {
                const body = JSON.stringify(r.body);
                assert.ok(body.includes('successfully deleted'), r.text);
                assert.ok(body.includes(schemaName), r.text);
                assert.equal(r.status, 200, r.text);
            }
        })
}

export async function describeSchema(schemaName) {
    await request(envUrl)
        .post('')
        .set(headers)
        .send({
            operation: 'describe_schema',
            schema: schemaName
        })
        .expect((r) => {
            Object.values(r.body).forEach(table => {
                assert.equal(table.schema, schemaName, r.text);
            })
        })
        .expect(200)
}

export async function checkTableInSchema(schemaName, checkTableName) {
    await request(envUrl)
        .post('')
        .set(headers)
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
            assert.equal(count, 0, r.text);
        })
        .expect(200)
}