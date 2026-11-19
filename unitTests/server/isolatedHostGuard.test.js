'use strict';

const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { isolatedApplicationHosts, isolatedApplicationUnavailable } = require('#src/server/isolatedHostGuard');

const request = (host) => ({ host, headers: { asObject: { host } } });

describe('shared workers and an isolated application host (harper#3052)', () => {
	const hosts = new Set(['pr-12.app.example.com']);

	it('answers 503 with Retry-After for the host, whatever its case or port', () => {
		for (const host of ['pr-12.app.example.com', 'PR-12.App.Example.com:9926', 'pr-12.app.example.com.']) {
			const response = isolatedApplicationUnavailable(request(host), false, undefined, hosts);
			assert.strictEqual(response?.status, 503, host);
			assert.strictEqual(response.headers.get('Retry-After'), '5');
			assert.strictEqual(response.headers.get('Cache-Control'), 'no-store');
		}
	});

	it("runs the pool's routes for any other host", () => {
		assert.strictEqual(isolatedApplicationUnavailable(request('www.example.com'), false, undefined, hosts), undefined);
		assert.strictEqual(isolatedApplicationUnavailable(request(undefined), false, undefined, hosts), undefined);
	});

	it("leaves the application's own worker, and the operations server, alone", () => {
		assert.strictEqual(
			isolatedApplicationUnavailable(request('pr-12.app.example.com'), false, 'shop-pr-12', hosts),
			undefined
		);
		assert.strictEqual(
			isolatedApplicationUnavailable(request('pr-12.app.example.com'), true, undefined, hosts),
			undefined
		);
	});

	it('takes the hosts the root config gives isolated applications, installed yet or not', () => {
		const config = {
			'guard-pr-1': { isolated: true, host: 'PR-1.app.example.com.' },
			'guard-pr-2': { isolated: true, host: 'pr-2.app.example.com' },
			'guard-ipv6': { isolated: true, host: '2001:db8::1' },
			'guard-bracketed': { isolated: true, host: '[2001:DB8::2]' },
			'guard-shared': { host: 'shared.example.com' },
			'guard-hostless': { isolated: true },
		};
		const hosts = isolatedApplicationHosts(config);
		assert.deepStrictEqual([...hosts], ['pr-1.app.example.com', 'pr-2.app.example.com', '2001:db8::1', '2001:db8::2']);
		for (const authority of ['[2001:db8::1]:9926', '[2001:db8::2]:9926', '[2001:db8::2]']) {
			assert.strictEqual(
				isolatedApplicationUnavailable(request(authority), false, undefined, hosts)?.status,
				503,
				authority
			);
		}
	});
});
