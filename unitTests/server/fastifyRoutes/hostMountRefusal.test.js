'use strict';

const assert = require('node:assert');
const { hostMountRefusal } = require('#src/server/fastifyRoutes');

describe('fastifyRoutes under a host mount (harper#3051)', () => {
	it('refuses in a shared worker, where its routes would answer on every host', () => {
		assert.match(hostMountRefusal('studio', 'studio.example.com', undefined), /cannot be constrained by host/);
	});

	it("refuses in another application's dedicated worker", () => {
		assert.match(hostMountRefusal('studio', 'studio.example.com', 'shop'), /cannot be constrained by host/);
	});

	it("loads in the application's own dedicated worker, which no other host reaches", () => {
		assert.strictEqual(hostMountRefusal('studio', 'studio.example.com', 'studio'), undefined);
	});

	it('loads without a host mount anywhere', () => {
		assert.strictEqual(hostMountRefusal('studio', undefined, undefined), undefined);
	});
});
