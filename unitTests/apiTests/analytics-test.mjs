import { assert } from 'chai';
import axios from 'axios';
import { setupTestApp } from './setupTestApp.mjs';
import { profile } from '../../ts-build/resources/analytics/profile.js';

describe('Analytics profiling user code', () => {
	before(async () => {
		await setupTestApp();
	});

	it('can sample user code and record it', async () => {
		await profile(); // restart the profile
		const start = Date.now();
		let response = await axios.post('http://localhost:9926/SimpleCache/3', {
			doExpensiveComputation: true,
		});
		assert.equal(response.status, 204);
		await profile();
		const analyticsResults = await databases.system.hdb_raw_analytics.search({
			conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: start }],
		});
		let analyticRecorded;
		for await (let { metrics } of analyticsResults) {
			analyticRecorded = metrics.find(({ metric, path }) => metric === 'cpu-profile');
			if (analyticRecorded) break;
		}
		assert(analyticRecorded, 'db-write was recorded in analytics');
		assert(analyticRecorded.mean > 20, 'db-write bytes count were recorded in analytics');
	});
});
