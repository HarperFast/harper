'use strict';

const assert = require('assert');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { handleApplication } = require('#src/server/static');

// A minimal Scope stand-in: captures the http registration and warning log so tests can
// assert on the middleware ordering options the plugin passes to the server.
function fakeScope(options = {}, mount = undefined) {
	const state = {
		httpOptions: undefined,
		warnings: [],
		changeListeners: [],
		restartRequests: 0,
		mount,
		listener: undefined,
		entryCallback: undefined,
	};
	const scope = {
		directory: '/fake/app',
		appName: 'fake-app',
		pluginName: 'static',
		// Mirrors Scope: the application mount an operator declared in the root config, and the
		// helper that turns a mount-relative base path into the absolute path a client sees.
		mount: state.mount,
		externalBasePath: (baseURLPath) => (state.mount?.urlPath ? `${state.mount.urlPath}${baseURLPath}` : baseURLPath),
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
		handleEntry(callback) {
			state.entryCallback = callback;
		},
		requestRestart: () => state.restartRequests++,
		server: {
			http: (listener, httpOptions) => {
				state.listener = listener;
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
	it('removes a directory-owned index when index.html unlinks', () => {
		const directory = mkdtempSync(join(tmpdir(), 'harper-static-index-unlink-'));
		const indexPath = join(directory, 'index.html');
		writeFileSync(indexPath, 'index');

		try {
			const { scope, state } = fakeScope();
			handleApplication(scope);
			state.entryCallback({ eventType: 'addDir', entryType: 'directory', absolutePath: directory, urlPath: '/' });
			state.entryCallback({ eventType: 'add', entryType: 'file', absolutePath: indexPath, urlPath: '/index.html' });
			rmSync(indexPath);
			state.entryCallback({ eventType: 'unlink', entryType: 'file', absolutePath: indexPath, urlPath: '/index.html' });

			const request = { method: 'GET', isWebSocket: false, pathname: '/', url: '/', headers: {} };
			const fallthrough = Symbol('fallthrough');
			assert.strictEqual(
				state.listener(request, () => fallthrough),
				fallthrough
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('keeps a replacement with the same URL when the old absolute file unlinks afterward', () => {
		const directory = mkdtempSync(join(tmpdir(), 'harper-static-identity-'));
		const oldPath = join(directory, 'web', 'index.html');
		const newPath = join(directory, 'dist', 'index.html');
		mkdirSync(join(directory, 'web'), { recursive: true });
		mkdirSync(join(directory, 'dist'), { recursive: true });
		writeFileSync(oldPath, 'old');
		writeFileSync(newPath, 'new');

		try {
			const { scope, state } = fakeScope();
			handleApplication(scope);
			const entry = (eventType, absolutePath) =>
				state.entryCallback({ eventType, entryType: 'file', absolutePath, urlPath: '/index.html' });
			entry('add', oldPath);
			entry('add', newPath);
			entry('unlink', oldPath);

			const request = {
				method: 'GET',
				isWebSocket: false,
				pathname: '/index.html',
				url: '/index.html',
				headers: {},
			};
			const fallthrough = Symbol('fallthrough');
			assert.notStrictEqual(
				state.listener(request, () => fallthrough),
				fallthrough
			);

			entry('unlink', newPath);
			assert.strictEqual(
				state.listener(request, () => fallthrough),
				fallthrough
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('restores a surviving colliding file when the active file unlinks', () => {
		const directory = mkdtempSync(join(tmpdir(), 'harper-static-collision-'));
		const oldPath = join(directory, 'web', 'index.html');
		const newPath = join(directory, 'dist', 'index.html');
		mkdirSync(join(directory, 'web'), { recursive: true });
		mkdirSync(join(directory, 'dist'), { recursive: true });
		writeFileSync(oldPath, 'old');
		writeFileSync(newPath, 'new');

		try {
			const { scope, state } = fakeScope();
			handleApplication(scope);
			const entry = (eventType, absolutePath) =>
				state.entryCallback({ eventType, entryType: 'file', absolutePath, urlPath: '/index.html' });
			entry('add', oldPath);
			entry('add', newPath);
			entry('unlink', newPath);

			const request = {
				method: 'GET',
				isWebSocket: false,
				pathname: '/index.html',
				url: '/index.html',
				headers: {},
			};
			const fallthrough = Symbol('fallthrough');
			assert.notStrictEqual(
				state.listener(request, () => fallthrough),
				fallthrough
			);

			entry('unlink', oldPath);
			assert.strictEqual(
				state.listener(request, () => fallthrough),
				fallthrough
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

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

	it('applies removals but ignores additions while a urlPath restart is pending', () => {
		const { scope, state } = fakeScope();
		handleApplication(scope);
		state.entryCallback({ eventType: 'add', entryType: 'file', absolutePath: __filename, urlPath: '/asset.js' });

		scope.fireChange('urlPath');
		state.entryCallback({ eventType: 'unlink', entryType: 'file', absolutePath: __filename, urlPath: '/asset.js' });
		state.entryCallback({ eventType: 'add', entryType: 'file', absolutePath: __filename, urlPath: '/new/asset.js' });

		const fallthrough = Symbol('fallthrough');
		assert.strictEqual(
			state.listener(
				{ method: 'GET', isWebSocket: false, pathname: '/asset.js', url: '/asset.js', headers: {} },
				() => fallthrough
			),
			fallthrough
		);
		assert.strictEqual(
			state.listener(
				{ method: 'GET', isWebSocket: false, pathname: '/new/asset.js', url: '/new/asset.js', headers: {} },
				() => fallthrough
			),
			fallthrough
		);
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

describe('static plugin mount-root redirect', () => {
	// A root-level static plugin (no urlPath of its own) has baseURLPath === '/', so gating the
	// redirect on baseURLPath alone never fires — even though the application mount makes the
	// client-visible root something other than '/'. Review finding: the mount root then serves
	// without ever redirecting to its trailing-slash form.
	it('redirects the application mount root to its trailing-slash form even when static has no urlPath of its own', () => {
		const { scope, state } = fakeScope({}, { urlPath: '/v1' });
		handleApplication(scope);
		state.entryCallback({ eventType: 'add', urlPath: '/index.html', absolutePath: '/fake/app/web/index.html' });

		const result = state.listener({ method: 'GET', pathname: '/', url: '/', originalPathname: '/v1' }, () => ({
			status: -1,
		}));

		assert.equal(result.status, 301);
		assert.equal(result.headers.Location, '/v1/');
	});

	it('does not redirect when the application has no mount (root stays root)', () => {
		const { scope, state } = fakeScope();
		handleApplication(scope);
		// A real, existing path — with no mount, the redirect guard is false and this falls through
		// to actually serving the file (realpathSync must succeed).
		state.entryCallback({ eventType: 'add', urlPath: '/index.html', absolutePath: __filename });

		const result = state.listener({ method: 'GET', pathname: '/', url: '/', originalPathname: '/' }, () => ({
			status: -1,
		}));

		assert.notEqual(result.status, 301);
	});
});
