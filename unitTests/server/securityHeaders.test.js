'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');

const harperLogger = require('#src/utility/logging/harper_logger');
const { handleApplication, universalHeaders } = require('#src/server/http');

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
	const ownedBefore = () => universalHeaders.length;

	beforeEach(() => {
		sandbox = sinon.createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
		// Reset any entries this feature may have left behind between tests.
		handleApplication(mockScope({}));
	});

	it('does nothing when securityHeaders is absent (opt-in, no behavior change)', () => {
		const before = ownedBefore();
		handleApplication(mockScope({}));
		assert.strictEqual(universalHeaders.length, before);
	});

	it('appends configured securityHeaders to universalHeaders', () => {
		handleApplication(
			mockScope({
				securityHeaders: {
					'X-Frame-Options': 'SAMEORIGIN',
					'X-Content-Type-Options': 'nosniff',
				},
			})
		);
		assert.deepStrictEqual(
			universalHeaders.filter(([name]) => name === 'X-Frame-Options' || name === 'X-Content-Type-Options'),
			[
				['X-Frame-Options', 'SAMEORIGIN'],
				['X-Content-Type-Options', 'nosniff'],
			]
		);
	});

	it('coerces non-string values to strings', () => {
		handleApplication(
			mockScope({
				securityHeaders: { 'X-Test-Number': 42, 'X-Test-Bool': true },
			})
		);
		assert.deepStrictEqual(
			universalHeaders.filter(([name]) => name.startsWith('X-Test-')),
			[
				['X-Test-Number', '42'],
				['X-Test-Bool', 'true'],
			]
		);
	});

	it('rejects invalid header names without throwing, and logs an error', () => {
		const errorStub = sandbox.stub(harperLogger, 'error');
		handleApplication(
			mockScope({
				securityHeaders: {
					'Bad Header Name': 'value',
					'X-Good-Header': 'ok',
				},
			})
		);
		assert.ok(errorStub.calledOnce);
		assert.ok(!universalHeaders.some(([name]) => name === 'Bad Header Name'));
		assert.ok(universalHeaders.some(([name]) => name === 'X-Good-Header'));
	});

	it('rejects invalid header values without throwing, and logs an error', () => {
		const errorStub = sandbox.stub(harperLogger, 'error');
		handleApplication(
			mockScope({
				securityHeaders: {
					'X-Bad-Value': 'line1\nline2',
				},
			})
		);
		assert.ok(errorStub.calledOnce);
		assert.ok(!universalHeaders.some(([name]) => name === 'X-Bad-Value'));
	});

	it('hot-reload replaces owned entries without clobbering entries pushed by other components', () => {
		// Simulate another component pushing its own universal header directly.
		const foreignEntry = ['X-Foreign-Header', 'from-other-component'];
		universalHeaders.push(foreignEntry);

		const scope = mockScope({ securityHeaders: { 'X-Frame-Options': 'SAMEORIGIN' } });
		handleApplication(scope);
		assert.ok(universalHeaders.some(([name]) => name === 'X-Frame-Options'));
		assert.ok(universalHeaders.includes(foreignEntry));

		// Hot-reload with a different config: old owned entry should be gone, new one present,
		// and the foreign entry must survive untouched.
		scope._reload({ securityHeaders: { 'X-Content-Type-Options': 'nosniff' } });
		assert.ok(!universalHeaders.some(([name]) => name === 'X-Frame-Options'));
		assert.ok(universalHeaders.some(([name]) => name === 'X-Content-Type-Options'));
		assert.ok(universalHeaders.includes(foreignEntry));

		// Clean up the foreign entry so it doesn't leak into other tests.
		const index = universalHeaders.indexOf(foreignEntry);
		if (index !== -1) universalHeaders.splice(index, 1);
	});

	it('hot-reload to an empty config removes all previously-owned entries', () => {
		const scope = mockScope({ securityHeaders: { 'X-Frame-Options': 'SAMEORIGIN' } });
		handleApplication(scope);
		assert.ok(universalHeaders.some(([name]) => name === 'X-Frame-Options'));

		scope._reload({});
		assert.ok(!universalHeaders.some(([name]) => name === 'X-Frame-Options'));
	});
});
