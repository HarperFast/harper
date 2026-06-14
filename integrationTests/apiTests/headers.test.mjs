/**
 * HTTP Header / Set-Cookie merging integration tests.
 *
 * Ported from legacy `apiTests/tests/27_headerTests.mjs`. Validates that
 * `mergeHeaders` in REST.ts preserves multiple `Set-Cookie` headers from both
 * middleware (`request.responseHeaders`) and application responses, and that
 * cookie values containing commas (e.g. `expires=` dates) are not split.
 *
 * Suite is self-contained: it installs an empty `headerTests` component, sets
 * `resources.js` + `config.yaml` via `set_component_file`, restarts http
 * workers so the component loads, then exercises the endpoints over REST.
 *
 * Skipped under Bun: Harper-on-Bun currently serializes multiple Set-Cookie
 * response headers as a single combined string instead of an array, which is
 * a runtime behavior difference rather than a bug in mergeHeaders. The legacy
 * `test:integration:api-tests` skips Bun entirely, so this code path was
 * never previously exercised under Bun.
 *
 * Skipped on Windows: `restart_service http_workers` crashes the Harper
 * instance on Windows (single-worker model + native-binding cleanup
 * collision during overlapping restart). Tracked as HarperFast/harper#549.
 * The legacy `27_headerTests.mjs` worked around the slow component install
 * with a local fixture but ultimately depends on the same restart path.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';
import { restartHttpWorkers } from './utils/lifecycle.mjs';

const RESOURCES_JS = `
// Test endpoint that sets multiple Set-Cookie headers via mergeHeaders
export class CookieTest extends Resource {
	get() {
		// Simulate auth middleware adding MULTIPLE session cookies to responseHeaders
		// This reproduces a bug where mergeHeaders passes an array to append with comma=true
		const context = this.getContext();
		context.responseHeaders.append('Set-Cookie', 'hdb-session=mock-session-id; Path=/; HttpOnly');
		context.responseHeaders.append('Set-Cookie', 'hdb-tracking=track123; Path=/; HttpOnly');

		// Create a response with multiple Set-Cookie headers from the application
		const response = {
			status: 200,
			headers: new Headers(),
			data: { message: 'Multiple cookies set' }
		};

		// Set multiple cookies - these will go through mergeHeaders in REST.ts
		// When mergeHeaders iterates over context.responseHeaders, it will get the Set-Cookie
		// value as an ARRAY, and then call append(name, arrayValue, true) which triggers the bug
		response.headers.append('Set-Cookie', 'app-cookie1=value1; Path=/; HttpOnly');
		response.headers.append('Set-Cookie', 'app-cookie2=value2; Path=/; Secure');
		response.headers.append('Set-Cookie', 'app-cookie3=value3; Path=/');

		return response;
	}
}

// Test endpoint that sets a cookie with expires date (containing comma)
export class CookieWithExpiresTest extends Resource {
	get() {
		const response = {
			status: 200,
			headers: new Headers(),
			data: { message: 'Cookie with expires date' }
		};

		// Set a cookie with an expiration date that contains a comma
		// This tests that the comma in the date doesn't cause cookie splitting
		response.headers.append('Set-Cookie', 'session=abc123; Path=/; expires=Wed, 21 Oct 2025 07:28:00 GMT; HttpOnly');
		response.headers.append('Set-Cookie', 'tracking=xyz789; Path=/; expires=Thu, 22 Oct 2025 08:00:00 GMT');

		return response;
	}
}
`;

const CONFIG_YAML = 'rest: true\njsResource:\n  files: resources.js';

// Skipped on Windows: `restart_service http_workers` crashes the Harper instance
// (HarperFast/harper#549). Matches the per-suite skip pattern in 23_blob.mjs.
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

suite('HTTP Header / Set-Cookie handling', { skip: skipSuite }, (ctx) => {
	let client;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		await client
			.req()
			.send({ operation: 'add_component', project: 'headerTests' })
			.expect((r) => {
				const res = JSON.stringify(r.body);
				assert.ok(res.includes('Successfully added project') || res.includes('Project already exists'), r.text);
			});

		await client
			.req()
			.send({
				operation: 'set_component_file',
				project: 'headerTests',
				file: 'resources.js',
				payload: RESOURCES_JS,
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: resources.js'), r.text))
			.expect(200);

		await client
			.req()
			.send({
				operation: 'set_component_file',
				project: 'headerTests',
				file: 'config.yaml',
				payload: CONFIG_YAML,
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: config.yaml'), r.text))
			.expect(200);

		// Use an extended timeout on CI — slow runners (especially under shard
		// contention) can take well over the default 60s to reload component routes
		// after restart_service http_workers.
		await restartHttpWorkers(client, '/CookieTest', 120000);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('mergeHeaders preserves multiple Set-Cookie headers', () => {
		return client
			.reqRest('/CookieTest')
			.expect((r) => {
				const setCookies = r.headers['set-cookie'];

				// Should be an array with multiple cookies (2 session + 3 app cookies = 5 total)
				assert.ok(Array.isArray(setCookies), 'set-cookie should be an array');
				assert.equal(setCookies.length, 5, 'Should have 5 cookies (2 session + 3 app)');

				// Verify session cookies from simulated middleware
				assert.ok(
					setCookies.some((c) => c.includes('hdb-session=mock-session-id')),
					'Should have hdb-session cookie from middleware'
				);
				assert.ok(
					setCookies.some((c) => c.includes('hdb-tracking=track123')),
					'Should have hdb-tracking cookie from middleware'
				);

				// Verify specific app cookies are present
				assert.ok(
					setCookies.some((c) => c.includes('app-cookie1=value1')),
					'Should have app-cookie1'
				);
				assert.ok(
					setCookies.some((c) => c.includes('app-cookie2=value2')),
					'Should have app-cookie2'
				);
				assert.ok(
					setCookies.some((c) => c.includes('app-cookie3=value3')),
					'Should have app-cookie3'
				);

				// Verify cookies are NOT comma-combined
				const hasCommaSeparatedCookies = setCookies.some((cookie) => {
					const parts = cookie.split(', ');
					return parts.length > 1 && parts.some((part) => part.includes('=') && !part.includes('expires='));
				});
				assert.ok(!hasCommaSeparatedCookies, 'Cookies should not be comma-separated');
			})
			.expect(200);
	});

	test('Set-Cookie with comma in expiration date is preserved', () => {
		return client
			.reqRest('/CookieWithExpiresTest')
			.expect((r) => {
				const setCookies = r.headers['set-cookie'];

				assert.ok(Array.isArray(setCookies), 'set-cookie should be an array');
				assert.equal(setCookies.length, 2, 'Should have 2 cookies');

				const sessionCookie = setCookies.find((c) => c.includes('session=abc123'));
				const trackingCookie = setCookies.find((c) => c.includes('tracking=xyz789'));

				assert.ok(sessionCookie, 'Should have session cookie');
				assert.ok(trackingCookie, 'Should have tracking cookie');

				// Verify the expires dates are intact with their commas
				assert.ok(sessionCookie.includes('expires=Wed, 21 Oct 2025'), 'Session cookie should have intact expires date');
				assert.ok(
					trackingCookie.includes('expires=Thu, 22 Oct 2025'),
					'Tracking cookie should have intact expires date'
				);

				// Verify cookies are separate (not combined)
				assert.ok(!sessionCookie.includes('tracking='), 'Session cookie should not contain tracking cookie');
				assert.ok(!trackingCookie.includes('session='), 'Tracking cookie should not contain session cookie');
			})
			.expect(200);
	});
});
