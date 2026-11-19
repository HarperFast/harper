'use strict';

const assert = require('node:assert');
const { corsAccessListAllows } = require('#src/utility/corsAccessList');

describe('corsAccessListAllows (harper#3050)', () => {
	const previews = ['https://*.app.example.com'];

	it('allows an exact entry, and any origin for `*`', () => {
		assert.ok(corsAccessListAllows(['https://studio.example.com'], 'https://studio.example.com'));
		assert.ok(!corsAccessListAllows(['https://studio.example.com'], 'https://other.example.com'));
		assert.ok(corsAccessListAllows(['*'], 'https://anything.example.org'));
	});

	it('allows exactly one label in place of the wildcard', () => {
		assert.ok(corsAccessListAllows(previews, 'https://david-1778-custom-regions.app.example.com'));
		assert.ok(corsAccessListAllows(previews, 'https://PR-12.App.Example.com'), 'hosts compare case-insensitively');
		for (const origin of [
			'https://app.example.com',
			'https://.app.example.com',
			'https://a.b.app.example.com',
			'https://-bad.app.example.com',
			'https://pr-12.app.example.com.evil.com',
			'https://pr-12_app.example.com',
		]) {
			assert.ok(!corsAccessListAllows(previews, origin), origin);
		}
	});

	it('requires the scheme and port to match exactly', () => {
		assert.ok(!corsAccessListAllows(previews, 'http://pr-12.app.example.com'));
		assert.ok(!corsAccessListAllows(previews, 'https://pr-12.app.example.com:8443'));
		assert.ok(corsAccessListAllows(['https://*.app.example.com:8443'], 'https://pr-12.app.example.com:8443'));
		assert.ok(!corsAccessListAllows(['https://*.app.example.com:8443'], 'https://pr-12.app.example.com'));
	});

	it('matches nothing for a wildcard anywhere else, or over a top-level domain', () => {
		for (const entry of ['*.app.example.com', 'https://pr-*.app.example.com', 'https://*.com', 'https://app.*.com']) {
			assert.ok(!corsAccessListAllows([entry], 'https://pr-12.app.example.com'), entry);
			assert.ok(!corsAccessListAllows([entry], 'https://pr-12.com'), entry);
		}
	});

	it('allows no request without an Origin, which fastify asks about too', () => {
		assert.strictEqual(corsAccessListAllows(previews, undefined), false);
		assert.strictEqual(corsAccessListAllows(['*'], undefined), false);
	});

	it('reads a string as a list of one entry, and anything else as allowing nothing', () => {
		assert.ok(corsAccessListAllows('https://*.app.example.com', 'https://pr-12.app.example.com'));
		assert.ok(!corsAccessListAllows(undefined, 'https://pr-12.app.example.com'));
		assert.ok(!corsAccessListAllows([null], 'https://pr-12.app.example.com'));
	});
});
