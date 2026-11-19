import { assert } from 'chai';
import axios from 'axios';
import { setupTestApp, baseUrl } from './setupTestApp.mjs';

// Regression coverage for #1254: fastifyRoutes-registered HTTP routes returned 404 (registered but
// never dispatched) on 5.1.0-beta.2. The testApp configures fastifyRoutes with `path: .`, so its
// routes are namespaced under the app name (`/testApp`). This asserts the route actually dispatches.
describe('fastifyRoutes dispatch', () => {
	before(async function () {
		this.timeout(100000);
		await setupTestApp();
	});

	it('dispatches a fastifyRoutes GET route (200, not 404)', async () => {
		const response = await axios({
			url: `${baseUrl}/testApp/ping`,
			method: 'GET',
			responseType: 'text',
		});
		assert.equal(response.status, 200);
		assert.equal(response.data, 'pong');
	});

	it('still serves REST resources on the same component', async () => {
		const response = await axios({
			url: `${baseUrl}/FourProp/0`,
			method: 'GET',
			responseType: 'json',
			headers: { accept: 'application/json' },
		});
		assert.equal(response.status, 200);
		assert.equal(response.data.id, '0');
	});
});
