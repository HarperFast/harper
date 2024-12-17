import request from 'supertest';
import assert from "node:assert";
import {envUrl} from "../config/envConfig.js";

export async function createSchema(schemaName) {
    await request(envUrl)
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

export async function dropSchema(schemaName, failTest) {
    await request(envUrl)
        .post('')
        .send({
            operation: 'drop_schema',
            schema: schemaName
        })
        .expect((r) => {
            if (failTest) {
                const body = JSON.stringify(r.body);
                assert.ok(body.includes('successfully deleted'));
                assert.ok(body.includes(schemaName));
                assert.equal(r.status, 200);
            }
        })
}

export async function describeSchema(schemaName) {
    await request(envUrl)
        .post('')
        .send({
            operation: 'describe_schema',
            schema: schemaName
        })
        .expect((r) => {
            Object.values(r.body).forEach(table => {
                assert.equal(table.schema, schemaName);
            })
        })
        .expect(200)
}

export async function checkTableInSchema(schemaName, checkTableName) {
    await request(envUrl)
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
        })
        .expect(200)
}