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
		restartRequests: 0,
	};
	const scope = {
		directory: '/fake/app',
		pluginName: 'static',
		options: {
			get: (key) => options[key[0]],
			getAll: () => options,
			on: (event, listener) => {
				if (event === 'change') state.changeListeners.push(listener);
			},
		},
		logger: {
			info() {},
			warn: (message) => state.warnings.push(message),
		},
		handleEntry() {},
		requestRestart: () => state.restartRequests++,
		server: {
			http: (_listener, httpOptions) => {
				state.httpOptions = httpOptions;
			},
		},
		// Simulate a live config reload for the given key, matching the real OptionsWatcher's
		// change-event signature of (key: string[], value, config).
		fireChange(key) {
			for (const listener of state.changeListeners) listener([key], options[key], options);
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

	it('before: false combined with after keeps the after constraint', () => {
		const { scope, state } = fakeScope({ before: false, after: 'rest' });
		handleApplication(scope);
		assert.equal(state.httpOptions.before, undefined);
		assert.equal(state.httpOptions.after, 'rest');
	});

	it('treats a bare `before:` key (null) as unset, preserving the default hoist', () => {
		const { scope, state } = fakeScope({ before: null });
		handleApplication(scope);
		assert.equal(state.httpOptions.before, 'authentication');
		assert.equal(state.httpOptions.after, undefined);
	});

	it('treats a bare `after:` key (null) as unset', () => {
		const { scope, state } = fakeScope({ after: null });
		handleApplication(scope);
		assert.equal(state.httpOptions.before, 'authentication');
		assert.equal(state.httpOptions.after, undefined);
	});

	it('rejects a non-string before', () => {
		const { scope } = fakeScope({ before: 42 });
		assert.throws(() => handleApplication(scope), /Invalid `before` option/);
	});

	it('rejects an empty-string before', () => {
		const { scope } = fakeScope({ before: '' });
		assert.throws(() => handleApplication(scope), /Invalid `before` option/);
	});

	it('rejects an empty-string after', () => {
		const { scope } = fakeScope({ after: '' });
		assert.throws(() => handleApplication(scope), /Invalid `after` option/);
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

	it('warns for an explicit before: authentication (same position as the default)', () => {
		const { scope, state } = fakeScope({ fallthrough: false, before: 'authentication' });
		handleApplication(scope);
		assert.equal(state.warnings.length, 1);
		assert.match(state.warnings[0], /after: 'rest'/);
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

	it('does not warn when a config save adds after: rest together with fallthrough: false', () => {
		const options = {};
		const { scope, state } = fakeScope(options);
		handleApplication(scope);
		// A single config save can change several options; the fallthrough change event must see
		// the live `after` value, not the one captured at registration.
		options.after = 'rest';
		options.fallthrough = false;
		scope.fireChange('fallthrough');
		assert.equal(state.warnings.length, 0);
	});
});

describe('static plugin ordering live reload', () => {
	it('requests a restart when before or after changes', () => {
		const { scope, state } = fakeScope();
		handleApplication(scope);
		scope.fireChange('before');
		assert.equal(state.restartRequests, 1);
		scope.fireChange('after');
		assert.equal(state.restartRequests, 2);
	});

	it('requests a restart when urlPath changes (route mount is fixed at load, #1583)', () => {
		const { scope, state } = fakeScope();
		handleApplication(scope);
		scope.fireChange('urlPath');
		assert.equal(state.restartRequests, 1);
	});

	it('does not request a restart for options read per-request', () => {
		const { scope, state } = fakeScope();
		handleApplication(scope);
		for (const key of ['fallthrough', 'notFound', 'index', 'extensions', 'files']) {
			scope.fireChange(key);
		}
		assert.equal(state.restartRequests, 0);
	});
});
