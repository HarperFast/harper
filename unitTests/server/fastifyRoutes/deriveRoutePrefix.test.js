'use strict';

const assert = require('assert');
const { deriveRoutePrefix } = require('#src/server/fastifyRoutes/helpers/deriveRoutePrefix');

// Regression coverage for #1254: the route prefix must honor the component's `urlPath`/`path`
// config rather than always namespacing under the app name. With no config, routes register at the
// root (empty prefix); the prior code forced a `/<appName>` prefix, moving default-config routes
// off the root and returning 404.
describe('deriveRoutePrefix', () => {
	it('returns an empty (root) prefix when no urlPath is configured (default config)', () => {
		assert.strictEqual(deriveRoutePrefix('my-app', undefined), '');
	});

	it('namespaces under the app name for the relative `.` urlPath (path: .)', () => {
		assert.strictEqual(deriveRoutePrefix('my-app', '.'), 'my-app');
	});

	it('uses an explicit urlPath as the prefix', () => {
		assert.strictEqual(deriveRoutePrefix('my-app', 'custom'), 'custom');
	});

	it('namespaces a relative sub-path under the app name', () => {
		assert.strictEqual(deriveRoutePrefix('my-app', './v1'), 'my-app/v1');
	});
});
