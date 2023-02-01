'use strict';
const config = require('./config.json');

module.exports = {
	getVariables,
	callOperation,
	removeAllSchemas,
};
function getVariables() {
	config.auth = 'Basic ' + btoa(config.username + ':' + config.password);
	config.url = `${config.protocol}://${config.host}:${config.port}`;
	return config;
}

async function callOperation(operation_object) {
	let { url, auth } = getVariables();
	return await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': auth,
		},
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
