'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';
import { getVariables } from './utility.js';
import { setProperty } from '../../utility/environment/environmentManager.js';
import { addThreads, setupTestApp, random } from './setupTestApp.mjs';
import why_is_node_running from 'why-is-node-still-running';
import { shutdownWorkers, setTerminateTimeout } from '../../server/threads/manageThreads.js';
const { authorization, url } = getVariables();

describe('Multi-threaded cache updates', () => {
	let available_records;
	before(async function () {
		this.timeout(500000);
		process.env.AUTHENTICATION_AUTHORIZELOCAL = 'true';
		available_records = await setupTestApp();
		await addThreads();
	});

	after(async function() {
		setTerminateTimeout(100);
		await shutdownWorkers('http');
	});
	it('Many updates and invalidations', async function () {
		this.timeout(15000);

		let responses = [];
		for (let i = 0; i < 1000; i++) {
			const put_values = [
				{
					id: Math.floor(random() * 10 + 20).toString(),
					prop1: random() + 'test',
					prop2: random(),
				},
				{
					id: Math.floor(random() * 10 + 20).toString(),
					prop3: random() + 'test',
					prop4: random(),
				},
			];
			responses.push(
				axios.put('http://localhost:9926/SimpleCache/', put_values)
			);
			responses.push(
				axios.post('http://localhost:9926/SimpleCache/' + Math.floor(random() * 10 + 20), {
					invalidate: true,
				})
			);
			responses.push(axios.get('http://localhost:9926/SimpleCache/' + Math.floor(random() * 10 + 20), {
				validateStatus: false
			}));

			while (responses.length > 10) {
				let response = await responses.shift();
				assert(response.status >= 200);
			}
		}
		for (let i = 0; i < 10; i++) {
			const response = await axios.get('http://localhost:9926/FourProp/' + (i + 20));
			assert(response.status >= 200);
			assert(response.data);
		}
		const history_of_24 = await tables.FourProp.getHistoryOfRecord('24');
		assert(history_of_24.length > 100);
		assert(history_of_24[0].type === 'put');
		let last_local_time = 0;
		for (let entry of history_of_24) {
			assert(entry.localTime > last_local_time);
			last_local_time = entry.localTime;
		}
		const history_of_cached_25 = await tables.SimpleCache.getHistoryOfRecord('25');
		assert(history_of_cached_25.filter(entry => entry.type === 'put').length > 100);
		assert(history_of_cached_25.filter(entry => entry.type === 'invalidate').length > 50);
	});
});
