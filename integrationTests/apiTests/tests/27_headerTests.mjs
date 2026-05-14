import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testData } from '../config/envConfig.mjs';
import { timestamp } from '../utils/timestamp.mjs';
import { restartServiceHttpWorkersWithTimeout } from '../utils/restart.mjs';
import { req, reqRest } from '../utils/request.mjs';

describe('27. HTTP Header Tests', () => {
	beforeEach(timestamp);

	it('Add component for header/cookie tests', () => {
		return req()
			.send({ operation: 'add_component', project: 'headerTests', template: process.platform === 'win32' ? 'file:' + join(__dirname, '../../fixtures/application-template-1.0.0.tgz') : undefined })
			.expect((r) => {
				const res = JSON.stringify(r.body);
				assert.ok(res.includes('Successfully added project') || res.includes('Project already exists'), r.text);
			});
	});

	it('Set Component File resources.js with cookie test endpoints', () => {
		return req()
			.send({
				operation: 'set_component_file',
				project: 'headerTests',
				file: 'resources.js',
				payload: `
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
`,
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: resources.js'), r.text))
			.expect(200);
	});

	it('Set Component File config.yaml', () => {
		return req()
			.send({
				operation: 'set_component_file',
				project: 'headerTests',
				file: 'config.yaml',
				payload: 'rest: true\njsResource:\n  files: resources.js',
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: config.yaml'), r.text))
			.expect(200);
	});

	it('Restart Service: http workers and wait', () => {
		return restartServiceHttpWorkersWithTimeout(testData.restartHttpWorkersTimeout);
	});

	it('Describe all', () => {
		return req().send({ operation: 'describe_all' }).expect(200);
	});

	it('[headers] mergeHeaders preserves multiple Set-Cookie headers', () => {
		// This test verifies that when middleware (like auth) sets Set-Cookie headers
		// via request.responseHeaders AND application code sets Set-Cookie headers,
		// they get merged via mergeHeaders in REST.ts and all cookies are preserved
		// and not comma-combined.

		return reqRest('/CookieTest')
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
				// If they were wrongly combined, we'd see something like: "cookie1=value1, cookie2=value2"
				const hasCommaSeparatedCookies = setCookies.some((cookie) => {
					// Check if the cookie contains a comma-space followed by another cookie assignment
					const parts = cookie.split(', ');
					return parts.length > 1 && parts.some((part) => part.includes('=') && !part.includes('expires='));
				});
				assert.ok(!hasCommaSeparatedCookies, 'Cookies should not be comma-separated');
			})
			.expect(200);
	});

	it('[headers] Set-Cookie with comma in expiration date is preserved', () => {
		// This test verifies that cookies with commas in their values
		// (like expiration dates) are not broken by comma-splitting

		return reqRest('/CookieWithExpiresTest')
			.expect((r) => {
				const setCookies = r.headers['set-cookie'];

				assert.ok(Array.isArray(setCookies), 'set-cookie should be an array');
				assert.equal(setCookies.length, 2, 'Should have 2 cookies');

				// Verify both cookies with expires dates are present and intact
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
