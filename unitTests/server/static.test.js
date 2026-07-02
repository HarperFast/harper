'use strict';

const assert = require('assert');
const { handleApplication } = require('#src/server/static');

// A minimal Scope stand-in: captures the http registration and warning log so tests can
// assert on the middleware ordering options the plugin passes to the server.
function fakeScope(options = {}) {
	const state = {
		httpOptions: undefined,
		warnings: [],
		changeListeners: [],
	};
	const scope = {
		directory: '/fake/app',
		options: {
			get: (key) => options[key[0]],
			on: (event, listener) => {
				if (event === 'change') state.changeListeners.push(listener);
			},
		},
		logger: {
			info() {},
			warn: (message) => state.warnings.push(message),
		},
		handleEntry() {},
		server: {
			http: (_listener, httpOptions) => {
				state.httpOptions = httpOptions;
			},
		},
		// Simulate a live config reload for the given key.
		fireChange(key) {
			for (const listener of state.changeListeners) listener([key]);
		},
	};
	return { scope, state };
}

describe('static plugin middleware ordering', () => {
	it('defaults to before: authentication', () => {
		const { scope, state } = fakeScope();
		handleApplication(scope);
		assert.equal(state.httpOptions.before, 'authentication');
		assert.equal(state.httpOptions.after, undefined);
	});

	it('passes an explicit before through', () => {
		const { scope, state } = fakeScope({ before: 'my-handler' });
		handleApplication(scope);
		assert.equal(state.httpOptions.before, 'my-handler');
	});

	it('before: false clears the default without adding a constraint', () => {
		const { scope, state } = fakeScope({ before: false });
		handleApplication(scope);
		assert.equal(state.httpOptions.before, undefined);
		assert.equal(state.httpOptions.after, undefined);
	});

	it('after suppresses the default before: authentication (would be a cycle)', () => {
		const { scope, state } = fakeScope({ after: 'rest' });
		handleApplication(scope);
		assert.equal(state.httpOptions.before, undefined);
		assert.equal(state.httpOptions.after, 'rest');
	});

	it('allows explicit before and after together', () => {
		const { scope, state } = fakeScope({ before: 'graphql', after: 'rest' });
		handleApplication(scope);
		assert.equal(state.httpOptions.before, 'graphql');
		assert.equal(state.httpOptions.after, 'rest');
	});

	it('rejects a non-string before', () => {
		const { scope } = fakeScope({ before: 42 });
		assert.throws(() => handleApplication(scope), /Invalid `before` option/);
	});

	it('rejects after: false (only before supports clearing)', () => {
		const { scope } = fakeScope({ after: false });
		assert.throws(() => handleApplication(scope), /Invalid `after` option/);
	});
});

describe('static plugin fallthrough: false warning', () => {
	it('warns when fallthrough: false runs in the default pre-REST position', () => {
		const { scope, state } = fakeScope({ fallthrough: false });
		handleApplication(scope);
		assert.equal(state.warnings.length, 1);
		assert.match(state.warnings[0], /after: 'rest'/);
	});

	it('does not warn when fallthrough is left at the default', () => {
		const { scope, state } = fakeScope();
		handleApplication(scope);
		assert.equal(state.warnings.length, 0);
	});

	it('does not warn when the handler is ordered after rest', () => {
		const { scope, state } = fakeScope({ fallthrough: false, after: 'rest' });
		handleApplication(scope);
		assert.equal(state.warnings.length, 0);
	});

	it('does not warn when before is set explicitly', () => {
		const { scope, state } = fakeScope({ fallthrough: false, before: false });
		handleApplication(scope);
		assert.equal(state.warnings.length, 0);
	});

	it('warns when a live reload turns fallthrough off', () => {
		const options = {};
		const { scope, state } = fakeScope(options);
		handleApplication(scope);
		assert.equal(state.warnings.length, 0);
		options.fallthrough = false;
		scope.fireChange('fallthrough');
		assert.equal(state.warnings.length, 1);
	});
});
