'use strict';

const assert = require('node:assert');
const { handleApplication } = require('#src/resources/loadEnv');

// A minimal Scope stand-in: captures the entry handler so the test can drive it directly.
function fakeScope(options = {}) {
	let handler;
	return {
		options: { getAll: () => options },
		handleEntry(cb) {
			handler = cb;
		},
		requestRestart() {},
		fire(entry) {
			handler(entry);
		},
	};
}

const addEntry = (contents) => ({ eventType: 'add', absolutePath: '/fake/.env', contents });

describe('loadEnv conflict handling', () => {
	const TOUCHED = ['__ENVTEST_F', '__ENVTEST_G'];

	afterEach(() => {
		for (const k of TOUCHED) delete process.env[k];
	});

	it('warns that config-shaping vars cannot shape instance config (#1513)', () => {
		const logger = require('#src/utility/logging/harper_logger');
		const warnings = [];
		const originalWarn = logger.warn;
		logger.warn = (msg) => warnings.push(String(msg));
		try {
			const scope = fakeScope();
			handleApplication(scope);
			scope.fire(addEntry('HARPER_SET_CONFIG=http.port=1234'));
		} finally {
			logger.warn = originalWarn;
			delete process.env.HARPER_SET_CONFIG;
		}
		assert.ok(
			warnings.some((w) => w.includes('HARPER_SET_CONFIG') && w.includes('cannot shape instance configuration')),
			`warned about the config-shaping var: ${JSON.stringify(warnings)}`
		);
	});

	it('never lets a config-shaping var reach process.env from a component .env (#1513)', () => {
		// Enforced at the injection point: downstream consumers that (re)compose
		// config from process.env must be able to rely on the trio arriving only
		// via sanctioned channels (heskew review, cross-PR with #1726).
		delete process.env.HARPER_SET_CONFIG;
		const scope = fakeScope({ override: true }); // even override must not inject
		handleApplication(scope);
		scope.fire(addEntry('HARPER_SET_CONFIG=http.port=1234'));
		assert.equal(process.env.HARPER_SET_CONFIG, undefined, 'trio var must not land in process.env');
	});

	it('keeps the existing value on a real conflict without override', () => {
		process.env.__ENVTEST_G = 'original';
		const scope = fakeScope();
		handleApplication(scope);
		scope.fire(addEntry('__ENVTEST_G=changed'));
		assert.equal(process.env.__ENVTEST_G, 'original');
	});

	it('overrides on a real conflict when override is enabled', () => {
		process.env.__ENVTEST_G = 'original';
		const scope = fakeScope({ override: true });
		handleApplication(scope);
		scope.fire(addEntry('__ENVTEST_G=changed'));
		assert.equal(process.env.__ENVTEST_G, 'changed');
	});
});
