import { describe, it } from 'node:test';
import  assert from "node:assert";
import request from 'supertest';

describe('Schemas and tables', () => {
    it('This is an example of testing the the describe all operation', async () => {
        await request('http://localhost:9925')
            .post('')
            .send({
                operation: 'describe_all'
            })
            .expect((r) => {
                assert.ok(Object.keys(r.body).length > 1);
                assert.ok(r.body.cucu.t1.hasOwnProperty('schema_defined'));
                assert.ok(r.body.data.Table2['schema'], 'data');
                assert.ok(Object.keys(r.body).includes('data'));
            })
            .expect(200)
    });
});
