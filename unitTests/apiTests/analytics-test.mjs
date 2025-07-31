import { assert } from 'chai';
import axios from 'axios';
import { setupTestApp } from './setupTestApp.mjs';
import { profile, userCodeFolders } from '../../ts-build/resources/analytics/profile.js';
import analytics from '../../ts-build/resources/analytics/write.js';

describe('Analytics profiling user code', () => {
	before(async () => {
		await setupTestApp();
		analytics.setAnalyticsEnabled(true);
		analytics.analyticsDelay = 50; // let's make this fast
		userCodeFolders.push(new URL('../testApp/', import.meta.url).toString());
	});

	it('can sample user code and record it', async () => {
		await profile(); // restart the profile
		const start = Date.now();
		let response = await axios.post('http://localhost:9926/SimpleCache/3', {
			doExpensiveComputation: true,
		});
		assert.equal(response.status, 204);
		await profile();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const analyticsResults = await databases.system.hdb_raw_analytics.search({
			conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: start }],
		});
		let userUsageRecorded, harperUsageRecorded;
		for await (let { metrics } of analyticsResults) {
			userUsageRecorded ??= metrics.find(({ metric, path }) => metric === 'cpu-usage' && path === 'user');
			harperUsageRecorded ??= metrics.find(({ metric, path }) => metric === 'cpu-usage' && path === 'harper');
		}
		assert(userUsageRecorded, 'user cpu-usage was recorded in analytics');
		assert(harperUsageRecorded, 'harper cpu-usage was recorded in analytics');
	});
	after(() => {
		analytics.setAnalyticsEnabled(false);
	});
});
