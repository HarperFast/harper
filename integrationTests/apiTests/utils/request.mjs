import request from 'supertest';
import { envUrl, envUrlRest, envUrlSecure, envUrlSecureRest, headers } from '../config/envConfig.mjs';
import https from 'node:https';

export function req() {
	return request(envUrl).post('').set(headers);
}

export function reqAsNonSU(customHeaders) {
	return request(envUrl).post('').set(customHeaders);
}

export function reqGraphQl() {
	return request(envUrlRest).post('/graphql').set(headers);
}

export function reqRest(urlPath) {
	return request(envUrlRest).get(urlPath).set(headers);
}

/**
 * Helper to create an HTTPS agent with certificate options
 * @param {Object} options - Certificate options
 * @returns {https.Agent} Configured HTTPS agent
 */
function createHttpsAgent(options = {}) {
	return new https.Agent({
		cert: options.cert,
		key: options.key,
		ca: options.ca,
		rejectUnauthorized: options.rejectUnauthorized ?? false,
	});
}

/**
 * Create a supertest request for HTTPS with optional client certificates
 * @param {Object} options - Options for the secure request
 * @param {string|Buffer} options.cert - Client certificate (PEM format)
 * @param {string|Buffer} options.key - Client private key (PEM format)
 * @param {string|Buffer} options.ca - CA certificate (PEM format)
 * @param {boolean} options.rejectUnauthorized - Whether to reject unauthorized certificates (default: false for testing)
 * @returns {request.Test} Supertest request object ready to send
 */
export function secureReq(options = {}) {
	return request(envUrlSecure).post('').agent(createHttpsAgent(options)).set(headers);
}

/**
 * Create a secure request as a non-super user
 * @param {Object} customHeaders - Custom headers for authentication
 * @param {Object} options - Options for the secure request (cert, key, ca, etc.)
 * @returns {request.Test} Supertest request object
 */
export function secureReqAsNonSU(customHeaders, options = {}) {
	return request(envUrlSecure).post('').agent(createHttpsAgent(options)).set(customHeaders);
}

/**
 * Create a secure GraphQL request
 * @param {Object} options - Options for the secure request (cert, key, ca, etc.)
 * @returns {request.Test} Supertest request object
 */
export function secureReqGraphQl(options = {}) {
	return request(envUrlSecureRest).post('/graphql').agent(createHttpsAgent(options)).set(headers);
}

/**
 * Create a secure REST request
 * @param {string} urlPath - The REST API path
 * @param {Object} options - Options for the secure request (cert, key, ca, etc.)
 * @returns {request.Test} Supertest request object
 */
export function secureReqRest(urlPath, options = {}) {
	return request(envUrlSecureRest).get(urlPath).agent(createHttpsAgent(options)).set(headers);
}
