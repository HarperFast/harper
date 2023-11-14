'use strict';

const env_mgr = require('../utility/environment/environmentManager');
env_mgr.initSync();
const terms = require('../utility/hdbTerms');
const http = require('http');

function cliOperations() {
	const postData = JSON.stringify({
		operation: 'describe_all',
	});

	const options = {
		socketPath: env_mgr.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET),
		method: 'POST',
		headers: {
			'Authorization': 'Basic YWRtaW46QWJjMTIzNCE=',
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(postData),
		},
	};

	const req = http.request(options, (res) => {
		console.log(`STATUS: ${res.statusCode}`);
		console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
		res.setEncoding('utf8');
		res.on('data', (chunk) => {
			console.log(`BODY: ${chunk}`);
		});
		res.on('end', () => {
			console.log('No more data in response.');
		});
	});

	req.on('error', (e) => {
		console.error(`problem with request: ${e.message}`);
	});

	// Write data to request body
	req.write(postData);
	req.end();
}

cliOperations();
