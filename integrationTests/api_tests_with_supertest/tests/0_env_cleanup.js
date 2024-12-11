import {describe, it, after, before} from 'node:test';
import {create_schema, drop_schema} from "../utils/schema.js";
import {global, headers, url} from "../config/env_config.js";
import {drop_table} from "../utils/table.js";
import {sleep} from "../utils/general.js";
import request from "supertest";
import assert from "node:assert";


describe('0. Environment Cleanup', () => {

    it('Environment Cleanup', async () => {
        try {
            await request(url)
                .post('')
                .send({
                    operation: 'describe_all'
                })
                .expect((r) => {
                    const keys = Object.keys(r.body);
                    keys.forEach(async (schema) => {
                        await drop_schema(url, schema, false);
                        await sleep(300);
                    });
                })
                .expect(200)

            await sleep(2000);
            await request(url)
                .post('')
                .send({
                    operation: 'describe_all'
                })
                .expect((r) => {
                    const keys = Object.keys(r.body);
                    assert.equal(keys.length, 0);
                })
                .expect(200)
        } catch (error) {
            console.error(error);
        }
    });
});