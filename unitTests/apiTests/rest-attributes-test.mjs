'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';
import { getVariables } from './utility.js';
import { setupTestApp } from './setupTestApp.mjs';
import why_is_node_running from 'why-is-node-still-running';
const { authorization, url } = getVariables();

describe('test REST calls', () => {
	let available_records;
	before(async () => {
		available_records = await setupTestApp();
	});

	it('put with wrong type on attribute', async () => {
		const headers = {
			//authorization,
			'content-type': '',
			accept: 'application/json'
		};
		let response = await axios.put('http://localhost:9926/FourProp/555', JSON.stringify({
			id: 555,
			name: 33,
			age: 'not a number',
		}), {
			headers,
			validateStatus: function (status) {
				return true;
			},
		});
		assert.equal(response.status, 400);
		assert(response.data.includes('Property name must be a string'));
		assert(response.data.includes('Property age must be an integer'));
	});
});
