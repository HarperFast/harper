'use strict';
const config = require('./config.json');

module.exports = {
	getVariables,
	callOperation,
	removeAllSchemas,
};
function getVariables() {
	if (config.username) config.authorization = 'Basic ' + btoa(config.username + ':' + config.password);
	config.url = `${config.protocol}://${config.host}:${config.port}`;
	return config;
}

function callOperation(operation_object, headers) {
	let { url, authorization } = getVariables();
	headers = headers || {
		'Content-Type': 'application/json',
	};
	if (authorization && !headers.authorization) headers.authorization = authorization;
	return fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(operation_object),
	});
}

async function removeAllSchemas() {
	let describe_response = await callOperation({ operation: 'describe_all' });
	const describe_body = await describe_response.json();
	for (const schema of Object.keys(describe_body)) {
		let drop_result = await callOperation({ operation: 'drop_schema', schema });
		let drop_body = await drop_result.json();
	}
}
