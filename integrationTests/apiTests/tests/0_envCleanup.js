import {describe, it, after, before} from 'node:test';
import {createSchema, dropSchema} from "../utils/schema.js";
import {dropTable} from "../utils/table.js";
import {setTimeout as sleep} from 'node:timers/promises';
import request from "supertest";
import assert from "node:assert";
import {envUrl, headers} from "../config/envConfig.js";


describe('0. Environment Cleanup', () => {

    it('Environment Cleanup', async () => {
        await request(envUrl)
            .post('')
            .set(headers)
            .send({
                operation: 'describe_all'
            })
            .expect((r) => {
                const keys = Object.keys(r.body);
                keys.forEach(async (schema) => {
                    await dropSchema(schema, false);
                    await sleep(300);
                });
            });
        await sleep(2000);
        await request(envUrl)
            .post('')
            .set(headers)
            .send({
                operation: 'describe_all'
            })
            .expect((r) => {
                const keys = Object.keys(r.body);
                assert.equal(keys.length, 0);
            })
            .expect(200)
    });
});