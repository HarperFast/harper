import request from 'supertest';
import { envUrl, envUrlRest, headers } from '../config/envConfig.js';

export function req() {
	return request(envUrl)
		.post('')
		.set(headers)
}

export function reqAsNonSU(customHeaders) {
	return request(envUrl)
		.post('')
		.set(customHeaders)
}

export function reqGraphQl() {
	return request(envUrlRest)
		.post('/graphql')
		.set(headers)
}

export function reqRest(urlPath) {
	return request(envUrlRest)
		.get(urlPath)
		.set(headers)
}