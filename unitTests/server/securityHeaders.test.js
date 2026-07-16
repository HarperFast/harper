'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');

const harperLogger = require('#src/utility/logging/harper_logger');
const { _resetSecurityHeadersOwnedForTest, handleApplication, universalHeaders } = require('#src/server/http');

/** Mock a component Scope with a live-reloadable `options.getAll()`/`options.on('change', cb)`. */
function mockScope(initialOptions) {
	let current = initialOptions;
	let changeListener;
	return {
		options: {
			getAll() {
				return current;
			},
			on(event, listener) {
				if (event === 'change') changeListener = listener;
			},
		},
		// test helper, not part of the real Scope interface
		_reload(nextOptions) {
			current = nextOptions;
			changeListener?.('http');
		},
	};
}

describe('http.securityHeaders', () => {
	let sandbox;
	let rootScope;

	before(() => {
		_resetSecurityHeadersOwnedForTest();
		rootScope = mockScope({});
		handleApplication(rootScope);
	});

	beforeEach(() => {
		sandbox = sinon.createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
		// Reset any entries this feature may have left behind between tests.
		rootScope._reload({});
	});

	it('does nothing when securityHeaders is absent (opt-in, no behavior change)', () => {
		const before = universalHeaders.length;
		rootScope._reload({});
		assert.strictEqual(universalHeaders.length, before);
	});

	it('appends configured securityHeaders to universalHeaders', () => {
		rootScope._reload({
			securityHeaders: {
				'X-Frame-Options': 'SAMEORIGIN',
				'X-Content-Type-Options': 'nosniff',
			},
		});
		assert.deepStrictEqual(
			universalHeaders.filter(([name]) => name === 'X-Frame-Options' || name === 'X-Content-Type-Options'),
			[
				['X-Frame-Options', 'SAMEORIGIN'],
				['X-Content-Type-Options', 'nosniff'],
			]
		);
	});

	it('coerces non-string values to strings', () => {
		rootScope._reload({
			securityHeaders: { 'X-Test-Number': 42, 'X-Test-Bool': true },
		});
		assert.deepStrictEqual(
			universalHeaders.filter(([name]) => name.startsWith('X-Test-')),
			[
				['X-Test-Number', '42'],
				['X-Test-Bool', 'true'],
			]
		);
	});

	it('rejects invalid header names without throwing, and logs an error', () => {
		rootScope._reload({
			securityHeaders: {
				'Bad Header Name': 'value',
				'X-Good-Header': 'ok',
			},
		});
		assert.ok(!universalHeaders.some(([name]) => name === 'Bad Header Name'));
		assert.ok(universalHeaders.some(([name]) => name === 'X-Good-Header'));
	});

	it('rejects invalid header values without throwing, and logs an error', () => {
		rootScope._reload({
			securityHeaders: {
				'X-Bad-Value': 'line1\nline2',
			},
		});
		assert.ok(!universalHeaders.some(([name]) => name === 'X-Bad-Value'));
	});

	it('rejects a non-object securityHeaders value without iterating it', () => {
		// A string would otherwise for-in over its indices and digit-named "headers" would
		// pass validateHeaderName.
		const errorStub = sandbox.stub(harperLogger, 'error');
		rootScope._reload({ securityHeaders: 'X-Frame-Options: SAMEORIGIN' });
		assert.ok(errorStub.calledOnce);
		assert.ok(!universalHeaders.some(([name]) => /^\d+$/.test(name)));
	});

	it('rejects an array securityHeaders value', () => {
		// Arrays pass typeof === 'object'; for-in over indices would produce digit-named headers.
		const errorStub = sandbox.stub(harperLogger, 'error');
		rootScope._reload({ securityHeaders: ['X-Frame-Options', 'SAMEORIGIN'] });
		assert.ok(errorStub.calledOnce);
		assert.ok(!universalHeaders.some(([name]) => /^\d+$/.test(name)));
	});

	it('hot-reload replaces owned entries without clobbering entries pushed by other components', () => {
		// Simulate another component pushing its own universal header directly.
		const foreignEntry = ['X-Foreign-Header', 'from-other-component'];
		universalHeaders.push(foreignEntry);

		try {
			rootScope._reload({ securityHeaders: { 'X-Frame-Options': 'SAMEORIGIN' } });
			assert.ok(universalHeaders.some(([name]) => name === 'X-Frame-Options'));
			assert.ok(universalHeaders.includes(foreignEntry));

			// Hot-reload with a different config: old owned entry should be gone, new one present,
			// and the foreign entry must survive untouched.
			rootScope._reload({ securityHeaders: { 'X-Content-Type-Options': 'nosniff' } });
			assert.ok(!universalHeaders.some(([name]) => name === 'X-Frame-Options'));
			assert.ok(universalHeaders.some(([name]) => name === 'X-Content-Type-Options'));
			assert.ok(universalHeaders.includes(foreignEntry));
		} finally {
			// Clean up the foreign entry so it doesn't leak into other tests.
			const index = universalHeaders.indexOf(foreignEntry);
			if (index !== -1) universalHeaders.splice(index, 1);
		}
	});

	it('hot-reload to an empty config removes all previously-owned entries', () => {
		rootScope._reload({ securityHeaders: { 'X-Frame-Options': 'SAMEORIGIN' } });
		assert.ok(universalHeaders.some(([name]) => name === 'X-Frame-Options'));

		rootScope._reload({});
		assert.ok(!universalHeaders.some(([name]) => name === 'X-Frame-Options'));
	});

	it('a second (application) scope with an http block cannot clobber root securityHeaders', () => {
		rootScope._reload({ securityHeaders: { 'X-Frame-Options': 'SAMEORIGIN' } });

		// An application config.yaml with an `http:` block re-invokes handleApplication;
		// it must not take over securityHeaders ownership.
		const appScope = mockScope({ securityHeaders: { 'X-App-Header': 'from-app' } });
		handleApplication(appScope);
		assert.ok(universalHeaders.some(([name]) => name === 'X-Frame-Options'));
		assert.ok(!universalHeaders.some(([name]) => name === 'X-App-Header'));

		// Nor can its change events.
		appScope._reload({ securityHeaders: { 'X-App-Header-2': 'from-app' } });
		assert.ok(universalHeaders.some(([name]) => name === 'X-Frame-Options'));
		assert.ok(!universalHeaders.some(([name]) => name === 'X-App-Header-2'));
	});
});
