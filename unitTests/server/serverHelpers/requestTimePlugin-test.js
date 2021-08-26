'use strict';

const fastify = require('fastify');
const request_time_plugin = require('../../../server/serverHelpers/requestTimePlugin');
const chai = require('chai');
const { expect } = chai;

function build(opts={}) {
    const app = fastify(opts);
    app.register(request_time_plugin);
    app.get('/', async function (request, reply) {
        return { hello: 'world' };
    });

    return app;
}

let app = build();

describe('test requestTimePlugin', ()=>{
    it('test happy path', async()=>{
        const response = await app.inject({
            method: 'GET',
            url: '/'
        });

        expect(response.headers).to.have.property('hdb-response-time');
        expect(response.headers['hdb-response-time']).to.be.gt(0);
    });
});
