'use strict';

const needle = require('needle');
const filter = require('../helpers/example');

// eslint-disable-next-line no-unused-vars,require-await
module.exports = async (server, { hdbCore, logger }) => {
  // GET, WITH NO preValidation AND USING hdbCore.requestWithoutAuthentication
  // BYPASSES ALL CHECKS: DO NOT USE RAW USER-SUBMITTED VALUES IN SQL STATEMENTS
  server.route({
    url: '/',
    method: 'GET',
    handler: (request) => {
      request.body= {
        operation: 'sql',
        sql: 'SELECT * FROM dev.dog ORDER BY dog_name'
      };
      return hdbCore.requestWithoutAuthentication(request);
    }
  })

  // POST, WITH STANDARD PASS-THROUGH BODY, PAYLOAD AND HDB AUTHENTICATION
  server.route({
    url: '/',
    method: 'POST',
    preValidation: hdbCore.preValidation,
    handler: hdbCore.request,
  });

  // GET, WITH ASYNC THIRD-PARTY AUTH PREVALIDATION
  server.route({
    url: '/:id',
    method: 'GET',
    preValidation: async (request, reply) => {
      /*
       *  takes the inbound authorization headers and sends them via http request to an external auth service
       */
      const result = await needle('get', 'https://jsonplaceholder.typicode.com/todos/1', { headers: { authorization: request.headers.authorization }});

      /*
       *  throw an authentication error based on the response body or statusCode
       */
      if (result.body.error || result.statusCode !== 200) {
        const errorString = result.body.error || 'Sorry, there was an error authenticating your request';
        logger.error(errorString);
        throw new Error(errorString);
      }
    },
    handler: async (request) => {
      request.body= {
        operation: 'sql',
        sql: `SELECT * FROM dev.dog WHERE id = ${request.params.id}`
      };

      /*
       * requestWithoutAuthentication bypasses the standard HarperDB authentication.
       * YOU MUST ADD YOUR OWN preValidation method above, or this method will be available to anyone.
       */
      const result = await hdbCore.requestWithoutAuthentication(request);

      return filter(result, ['dog_name', 'owner_name', 'breed']);
    }
  })
};
