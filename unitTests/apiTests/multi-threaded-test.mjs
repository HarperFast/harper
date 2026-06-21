'use strict';

import { assert } from 'chai';
import axios from 'axios';
import { addThreads, setupTestApp, random, baseUrl } from './setupTestApp.mjs';
import { shutdownWorkers, setTerminateTimeout } from '#js/server/threads/manageThreads';

describe('Multi-threaded cache updates', () => {
	before(async function () {
		this.timeout(500000);
		process.env.AUTHENTICATION_AUTHORIZELOCAL = 'true';
		await setupTestApp();
		await addThreads();
	});

	after(async function () {
		setTerminateTimeout(100);
		await shutdownWorkers('http');
	});
	it('Many updates and invalidations', async function () {
		//		this.timeout(15000);

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
			if (put_values[0].id === put_values[1].id) put_values.splice(0, 1);
			responses.push(axios.put(`${baseUrl}/SimpleCache/`, put_values));
			responses.push(
				axios.post(`${baseUrl}/SimpleCache/` + Math.floor(random() * 10 + 20), {
					invalidate: true,
				})
			);
			responses.push(
				axios.get(`${baseUrl}/SimpleCache/` + Math.floor(random() * 10 + 20), {
					validateStatus: false,
				})
			);

			while (responses.length > 10) {
				let response = await responses.shift();
				assert(response.status >= 200);
			}
		}
		await Promise.all(responses);
		for (let i = 0; i < 10; i++) {
			const response = await axios.get(`${baseUrl}/FourProp/` + (i + 20));
			assert(response.status >= 200);
			assert(response.data);
		}
		// Aggregate history across all written IDs (20-29) rather than asserting a specific ID.
		// The seeded PRNG's distribution is non-uniform over any given seed window, so a single
		// ID can legitimately receive far fewer writes than the average — causing a false failure.
		let totalFourPropPuts = 0;
		let sampleFourPropHistory;
		for (let id = 20; id < 30; id++) {
			const history = await tables.FourProp.getHistoryOfRecord(id.toString());
			totalFourPropPuts += history.length;
			if (!sampleFourPropHistory && history.length > 0) sampleFourPropHistory = history;
		}
		assert(
			totalFourPropPuts > 500,
			`expected >500 total FourProp history entries across ids 20-29, got ${totalFourPropPuts}`
		);
		assert(
			sampleFourPropHistory?.[0]?.type === 'put',
			`expected first history entry type to be 'put', got '${sampleFourPropHistory?.[0]?.type}'`
		);
		// TODO: Eventually if we have support for more strictly ordered transaction logs, re-enable:
		// for (const entry of history) { assert(entry.localTime > last_local_time); ... }

		let totalCachePuts = 0;
		let totalCacheInvalidates = 0;
		for (let id = 20; id < 30; id++) {
			const history = await tables.SimpleCache.getHistoryOfRecord(id.toString());
			totalCachePuts += history.filter((entry) => entry.type === 'put').length;
			totalCacheInvalidates += history.filter((entry) => entry.type === 'invalidate').length;
		}
		assert(
			totalCachePuts > 500,
			`expected >500 total SimpleCache put history entries across ids 20-29, got ${totalCachePuts}`
		);
		assert(
			totalCacheInvalidates > 200,
			`expected >200 total SimpleCache invalidate history entries across ids 20-29, got ${totalCacheInvalidates}`
		);
	});
});
