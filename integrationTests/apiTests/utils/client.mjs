import request from 'supertest';
import https from 'node:https';

/**
 * Build basic-auth headers used by all Harper operations API calls.
 */
export function createHeaders(username, password) {
	return {
		'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
		'Content-Type': 'application/json',
		'Connection': 'close',
	};
}

function createHttpsAgent(options = {}) {
	return new https.Agent({
		cert: options.cert,
		key: options.key,
		ca: options.ca,
		rejectUnauthorized: options.rejectUnauthorized ?? false,
	});
}

/**
 * Build a Harper API client bound to a started Harper instance.
 *
 * Mirrors the legacy `utils/request.mjs` + `config/envConfig.mjs` helpers, but
 * scoped to a HarperContext from @harperfast/integration-testing instead of
 * process-global URLs/headers, so each test file can drive its own instance.
 *
 * @param {import('@harperfast/integration-testing').HarperContext} harper
 * @param {{ secureOperationsURL?: string, secureRestURL?: string }} [options]
 */
export function createApiClient(harper, options = {}) {
	const operationsURL = harper.operationsAPIURL;
	const restURL = harper.httpURL;
	const headers = createHeaders(harper.admin.username, harper.admin.password);

	return {
		headers,
		operationsURL,
		restURL,
		req: () => request(operationsURL).post('').set(headers),
		reqAs: (custom) => request(operationsURL).post('').set(custom),
		reqRest: (urlPath) => request(restURL).get(urlPath).set(headers),
		reqGraphQl: () => request(restURL).post('/graphql').set(headers),
		secureReq: (agentOptions = {}) => {
			if (!options.secureOperationsURL) {
				throw new Error('secureReq requires options.secureOperationsURL to be configured');
			}
			return request(options.secureOperationsURL).post('').agent(createHttpsAgent(agentOptions)).set(headers);
		},
		secureReqAs: (custom, agentOptions = {}) => {
			if (!options.secureOperationsURL) {
				throw new Error('secureReqAs requires options.secureOperationsURL to be configured');
			}
			return request(options.secureOperationsURL).post('').agent(createHttpsAgent(agentOptions)).set(custom);
		},
		secureReqRest: (urlPath, agentOptions = {}) => {
			if (!options.secureRestURL) {
				throw new Error('secureReqRest requires options.secureRestURL to be configured');
			}
			return request(options.secureRestURL).get(urlPath).agent(createHttpsAgent(agentOptions)).set(headers);
		},
		secureReqGraphQl: (agentOptions = {}) => {
			if (!options.secureRestURL) {
				throw new Error('secureReqGraphQl requires options.secureRestURL to be configured');
			}
			return request(options.secureRestURL).post('/graphql').agent(createHttpsAgent(agentOptions)).set(headers);
		},
	};
}
