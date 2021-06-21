'use strict';

const https = require('https');

const authRequest = (options) => {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      res.setEncoding('utf8');
      let responseBody = '';

      res.on('data', (chunk) => {
        responseBody += chunk;
      });

      res.on('end', () => {
        resolve(JSON.parse(responseBody));
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
};

const customValidation = async (request,logger) => {
  const options = {
    hostname: 'jsonplaceholder.typicode.com',
    port: 443,
    path: '/todos/1',
    method: 'GET',
    headers: { authorization: request.headers.authorization },
  };

  const result = await authRequest(options);

  /*
   *  throw an authentication error based on the response body or statusCode
   */
  if (result.error) {
    const errorString = result.error || 'Sorry, there was an error authenticating your request';
    logger.error(errorString);
    throw new Error(errorString);
  }
  return request;
};

module.exports = customValidation;
