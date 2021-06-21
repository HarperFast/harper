'use strict';

const customValidation = require('../helpers/example');

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
  });

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
    preValidation: (request) => customValidation(request, logger),
    handler: (request) => {
      request.body= {
        operation: 'sql',
        sql: `SELECT * FROM dev.dog WHERE id = ${request.params.id}`
      };

      /*
       * requestWithoutAuthentication bypasses the standard HarperDB authentication.
       * YOU MUST ADD YOUR OWN preValidation method above, or this method will be available to anyone.
       */
      return hdbCore.requestWithoutAuthentication(request);
    }
  });
};
