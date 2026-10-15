'use strict';

const assert = require('assert');
const http = require('node:http');
const http2 = require('node:http2');
const { Readable } = require('node:stream');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const send = require('send');
const { handleApplication } = require('#src/server/static');
const { httpServer, pipeBodyToResponse } = require('#src/server/http');
const analyticsWrite = require('#src/resources/analytics/write');
const { ClientError } = require('#src/utility/errors/hdbError');
const { waitFor } = require('../waitFor');
const {
	credentialRejectionError,
	deferCredentialRejection,
	getDeferredCredentialRejection,
} = require('#src/security/deferredAuthentication');

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

	it('keeps the registered route while only a urlPath restart is pending', () => {
		const { scope, state } = fakeScope();
		handleApplication(scope);
		state.entryCallback({ eventType: 'add', entryType: 'file', absolutePath: __filename, urlPath: '/asset.js' });

		scope.fireChange('urlPath');
		state.entryCallback({ eventType: 'unlink', entryType: 'file', absolutePath: __filename, urlPath: '/asset.js' });
		state.entryCallback({ eventType: 'add', entryType: 'file', absolutePath: __filename, urlPath: '/new/asset.js' });

		const fallthrough = Symbol('fallthrough');
		assert.notStrictEqual(
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

	it('applies file-selection removals while a urlPath restart is pending', () => {
		const { scope, state } = fakeScope();
		handleApplication(scope);
		state.entryCallback({ eventType: 'add', entryType: 'file', absolutePath: __filename, urlPath: '/asset.js' });

		scope.fireChange('urlPath');
		scope.fireChange('files');
		state.entryCallback({ eventType: 'unlink', entryType: 'file', absolutePath: __filename, urlPath: '/asset.js' });
		state.entryCallback({ eventType: 'add', entryType: 'file', absolutePath: __filename, urlPath: '/new/asset.js' });

		const fallthrough = Symbol('fallthrough');
		for (const pathname of ['/asset.js', '/new/asset.js']) {
			assert.strictEqual(
				state.listener({ method: 'GET', isWebSocket: false, pathname, url: pathname, headers: {} }, () => fallthrough),
				fallthrough
			);
		}
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
		state.entryCallback({ eventType: 'add', urlPath: '/index.html', absolutePath: __filename });

		const result = state.listener({ method: 'GET', pathname: '/', url: '/', originalPathname: '/' }, () => ({
			status: -1,
		}));

		assert.notEqual(result.status, 301);
	});
});

function staticRequest(pathname, { url = pathname, originalPathname, authorization } = {}) {
	const asObject = { accept: 'application/json' };
	if (authorization) asObject.authorization = authorization;
	return {
		method: 'GET',
		isWebSocket: false,
		pathname,
		url,
		originalPathname,
		headers: { asObject, get: (name) => asObject[name.toLowerCase()] },
	};
}

const NEXT_HANDLER = Symbol('next handler');
const next = () => NEXT_HANDLER;

function assertSettledUnauthorized(result, request, authorization) {
	assert.equal(result.status, 401, 'a static-owned response must settle the deferred rejection');
	assert.equal(result.headers.get('Content-Type'), 'application/json');
	assert.deepStrictEqual(JSON.parse(result.body.toString()), { error: 'Login failed' });
	assert.equal(request.headers.get('authorization'), authorization);
}

describe('static plugin deferred credential rejection', () => {
	const BASIC = 'Basic d29yZHByZXNzOmFwcC1wYXNzd29yZA==';
	const BEARER = 'Bearer downstream-owned-token';

	function deferred(request) {
		deferCredentialRejection(request, credentialRejectionError('Login failed', 401), 'Basic');
		return request;
	}

	it('settles the mount-root redirect instead of answering 301', () => {
		const { scope, state } = fakeScope({ after: 'rest' }, { urlPath: '/v1' });
		handleApplication(scope);
		state.entryCallback({ eventType: 'add', urlPath: '/index.html', absolutePath: '/fake/app/web/index.html' });

		const request = deferred(staticRequest('/', { originalPathname: '/v1', authorization: BASIC }));
		const result = state.listener(request, next);

		assertSettledUnauthorized(result, request, BASIC);
	});

	it('settles the trailing-slash directory redirect instead of answering 301', () => {
		const { scope, state } = fakeScope({ after: 'rest' });
		handleApplication(scope);
		state.entryCallback({
			eventType: 'add',
			urlPath: '/docs/index.html',
			absolutePath: '/fake/app/web/docs/index.html',
		});

		const request = deferred(staticRequest('/docs', { authorization: BEARER }));
		const result = state.listener(request, next);

		assertSettledUnauthorized(result, request, BEARER);
	});

	it('settles the built-in fallthrough: false 404 instead of answering "File not found"', () => {
		const { scope, state } = fakeScope({ fallthrough: false, after: 'rest' });
		handleApplication(scope);

		const request = deferred(staticRequest('/wp-json/wc/v3/orders', { authorization: BASIC }));
		const result = state.listener(request, next);

		assertSettledUnauthorized(result, request, BASIC);
	});

	it('settles the configured notFound response instead of serving the fallback page', () => {
		const directory = mkdtempSync(join(tmpdir(), 'harper-static-notfound-'));
		writeFileSync(join(directory, 'spa.html'), '<html>spa</html>');

		try {
			const { scope, state } = fakeScope({
				fallthrough: false,
				after: 'rest',
				notFound: { file: 'spa.html', statusCode: 200 },
			});
			scope.directory = directory;
			handleApplication(scope);

			const request = deferred(staticRequest('/app/route', { authorization: BEARER }));
			const result = state.listener(request, next);

			assertSettledUnauthorized(result, request, BEARER);
			assert.equal(result.handlesHeaders, undefined, 'the settled 401 is not the send() stream response');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('settles the ordinary file response', () => {
		const { scope, state } = fakeScope({ after: 'rest' });
		handleApplication(scope);
		state.entryCallback({ eventType: 'add', urlPath: '/asset.js', absolutePath: __filename });

		const request = deferred(staticRequest('/asset.js', { authorization: BASIC }));
		const result = state.listener(request, next);

		assertSettledUnauthorized(result, request, BASIC);
	});

	it('leaves the rejection deferred on the actual fallthrough so a downstream owner still decides', () => {
		const { scope, state } = fakeScope({ after: 'rest' });
		handleApplication(scope);

		const request = deferred(staticRequest('/wp-json/wc/v3/orders', { authorization: BASIC }));
		const result = state.listener(request, next);

		assert.strictEqual(result, NEXT_HANDLER);
		assert.equal(getDeferredCredentialRejection(request).status, 401);
		assert.equal(request.headers.get('authorization'), BASIC);
		assert.equal(request.user, undefined);
	});

	it('leaves a non-GET request deferred', () => {
		const { scope, state } = fakeScope({ fallthrough: false, after: 'rest' });
		handleApplication(scope);

		const request = deferred(staticRequest('/app/route', { authorization: BASIC }));
		request.method = 'POST';

		assert.strictEqual(state.listener(request, next), NEXT_HANDLER);
		assert.equal(getDeferredCredentialRejection(request).status, 401);
	});
});

describe('static plugin responses without a deferred rejection', () => {
	it('still redirects the mount root, preserving the query string', () => {
		const { scope, state } = fakeScope({ after: 'rest' }, { urlPath: '/v1' });
		handleApplication(scope);
		state.entryCallback({ eventType: 'add', urlPath: '/index.html', absolutePath: '/fake/app/web/index.html' });

		const result = state.listener(staticRequest('/', { url: '/?a=1', originalPathname: '/v1' }), next);

		assert.equal(result.status, 301);
		assert.equal(result.headers.Location, '/v1/?a=1');
	});

	it('still redirects a directory to its trailing-slash form, preserving the query string', () => {
		const { scope, state } = fakeScope({ after: 'rest' });
		handleApplication(scope);
		state.entryCallback({
			eventType: 'add',
			urlPath: '/docs/index.html',
			absolutePath: '/fake/app/web/docs/index.html',
		});

		const result = state.listener(staticRequest('/docs', { url: '/docs?a=1' }), next);

		assert.equal(result.status, 301);
		assert.equal(result.headers.Location, '/docs/?a=1');
	});

	it('still rebuilds the directory redirect against an application mount', () => {
		const { scope, state } = fakeScope({ after: 'rest' }, { urlPath: '/v1' });
		handleApplication(scope);
		state.entryCallback({
			eventType: 'add',
			urlPath: '/docs/index.html',
			absolutePath: '/fake/app/web/docs/index.html',
		});

		const result = state.listener(staticRequest('/docs'), next);

		assert.equal(result.status, 301);
		assert.equal(result.headers.Location, '/v1/docs/');
	});

	it('still answers the built-in 404 body', () => {
		const { scope, state } = fakeScope({ fallthrough: false, after: 'rest' });
		handleApplication(scope);

		const result = state.listener(staticRequest('/missing'), next);

		assert.equal(result.status, 404);
		assert.equal(result.body, 'File not found');
	});

	it('still serves the configured notFound file with its status code', () => {
		const directory = mkdtempSync(join(tmpdir(), 'harper-static-notfound-ok-'));
		writeFileSync(join(directory, 'spa.html'), '<html>spa</html>');

		try {
			const { scope, state } = fakeScope({
				fallthrough: false,
				after: 'rest',
				notFound: { file: 'spa.html', statusCode: 200 },
			});
			scope.directory = directory;
			handleApplication(scope);

			const result = state.listener(staticRequest('/app/route'), next);

			assert.equal(result.status, 200);
			assert.equal(result.handlesHeaders, true);
			assert.equal(typeof result.body.pipe, 'function');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

const REQUEST_TIMEOUT_MS = 5000;
let nextTestPort = 19470;

function listenWith(dispatch) {
	const port = nextTestPort++;
	const [server] = httpServer((req, next) => dispatch.current(req, next), { port, name: `staticUnit${port}` });
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
	});
}

// A reset before the status line rejects; a body cut off after the head resolves with `complete: false`.
function fetchHttp(baseUrl, urlPath) {
	return new Promise((resolve, reject) => {
		const req = http.get(`${baseUrl}${urlPath}`, { agent: false }, (res) => {
			const chunks = [];
			const finish = (complete) =>
				resolve({
					status: res.statusCode,
					headers: res.headers,
					body: Buffer.concat(chunks).toString('utf8'),
					complete,
				});
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => finish(res.complete));
			res.on('aborted', () => finish(false));
			res.on('error', () => finish(false));
		});
		req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('Request timed out')));
		req.on('error', reject);
	});
}

describe('static plugin serves files whose path would trip send URL handling', () => {
	let tempRoot;
	let server;
	let baseUrl;
	const dispatch = { current: null };

	before(async () => {
		({ server, baseUrl } = await listenWith(dispatch));
	});

	after(() => {
		server?.closeAllConnections();
		server?.close();
	});

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), 'harper-static-names-'));
	});

	afterEach(() => {
		if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	});

	function serveApp(files, options = {}) {
		const appDir = join(tempRoot, '.hidden-dir', 'app');
		const { scope, state } = fakeScope({ fallthrough: false, ...options });
		scope.directory = appDir;
		handleApplication(scope);
		for (const [name, content] of Object.entries(files)) {
			const absolutePath = join(appDir, 'web', name);
			mkdirSync(join(absolutePath, '..'), { recursive: true });
			writeFileSync(absolutePath, content);
			state.entryCallback({ eventType: 'add', urlPath: `/${name}`, absolutePath });
		}
		dispatch.current = (req) => state.listener(req, () => ({ status: 404, body: 'next' }));
		return { appDir, state };
	}

	it('serves a file when the application root is under a dot-directory', async () => {
		serveApp({ 'hello.txt': 'hello', '.well-known/security.txt': 'Contact: mailto:security@example.com' });

		const hello = await fetchHttp(baseUrl, '/hello.txt');
		assert.equal(hello.status, 200);
		assert.equal(hello.body, 'hello');
		assert.match(hello.headers['content-type'], /text\/plain/);

		const wellKnown = await fetchHttp(baseUrl, '/.well-known/security.txt');
		assert.equal(wellKnown.status, 200);
		assert.equal(wellKnown.body, 'Contact: mailto:security@example.com');
	});

	it('serves the notFound page when the application root is under a dot-directory', async () => {
		serveApp({ '404.html': '<h1>missing</h1>' }, { notFound: { file: 'web/404.html', statusCode: 404 } });

		const res = await fetchHttp(baseUrl, '/nothing-here');
		assert.equal(res.status, 404);
		assert.equal(res.body, '<h1>missing</h1>');
	});

	it('serves a file whose name contains a percent sign', async () => {
		serveApp({ 'discount-50%.txt': 'half off', 'hello%20world.txt': 'literal escape' });

		const literal = await fetchHttp(baseUrl, '/discount-50%.txt');
		assert.equal(literal.status, 200);
		assert.equal(literal.body, 'half off');

		// the name on disk is `hello%20world.txt`; send must not decode it to `hello world.txt`
		const escaped = await fetchHttp(baseUrl, '/hello%20world.txt');
		assert.equal(escaped.status, 200);
		assert.equal(escaped.body, 'literal escape');
	});

	it('serves a symlinked file whose target is inside a dot-directory', async function () {
		const { appDir, state } = serveApp({});
		const target = join(tempRoot, '.store', 'pkg', 'bundle.js');
		mkdirSync(join(target, '..'), { recursive: true });
		writeFileSync(target, 'export const bundled = true;');
		const link = join(appDir, 'web', 'bundle.js');
		mkdirSync(join(link, '..'), { recursive: true });
		try {
			symlinkSync(target, link);
		} catch (error) {
			if (process.platform === 'win32') return this.skip();
			throw error;
		}
		state.entryCallback({ eventType: 'add', urlPath: '/bundle.js', absolutePath: link });

		const res = await fetchHttp(baseUrl, '/bundle.js');
		assert.equal(res.status, 200);
		assert.equal(res.body, 'export const bundled = true;');
	});

	it('keeps answering 404 for an entry that is a dotfile or links to one', async function () {
		const { appDir, state } = serveApp({ '.hidden.txt': 'hidden' });
		const secret = join(appDir, '.env');
		writeFileSync(secret, 'SECRET=1');
		const link = join(appDir, 'web', 'config.txt');
		try {
			symlinkSync(secret, link);
		} catch (error) {
			if (process.platform === 'win32') return this.skip();
			throw error;
		}
		state.entryCallback({ eventType: 'add', urlPath: '/config.txt', absolutePath: link });

		for (const urlPath of ['/.hidden.txt', '/config.txt']) {
			const res = await fetchHttp(baseUrl, urlPath);
			assert.equal(res.status, 404, urlPath);
			assert.ok(!res.body.includes('SECRET'), urlPath);
		}
	});
});

describe('pipeBodyToResponse before the response head is written', () => {
	let tempRoot;
	let server;
	let baseUrl;
	const reported = [];
	const dispatch = { current: null };

	before(async () => {
		({ server, baseUrl } = await listenWith(dispatch));
		tempRoot = mkdtempSync(join(tmpdir(), 'harper-static-preheader-'));
		analyticsWrite.addAnalyticsListener((metrics) => {
			for (const { metric, path, count } of metrics) {
				if (metric.startsWith('response_')) reported.push({ metric, path, count });
			}
		});
	});

	after(() => {
		server?.closeAllConnections();
		server?.close();
		if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	});

	const failing =
		(error, stage = () => {}) =>
		(req) => {
			stage(req._nodeResponse);
			return {
				handlesHeaders: true,
				body: new Readable({
					read() {
						this.destroy(error);
					},
				}),
			};
		};

	it('answers a stream error that carries a status with that status, headers and no stale entity headers', async () => {
		dispatch.current = failing(
			Object.assign(new Error('try later'), { statusCode: 503, headers: { 'Retry-After': '5' } }),
			(res) => {
				res.setHeader('Content-Length', '4096');
				res.setHeader('Content-Type', 'text/html');
				res.setHeader('ETag', '"abc"');
				res.setHeader('Last-Modified', 'Wed, 21 Oct 2015 07:28:00 GMT');
				res.setHeader('Cache-Control', 'public, max-age=3600');
				res.setHeader('X-Frame-Options', 'DENY');
				res.setHeader('Vary', 'Accept-Encoding');
				res.setHeader('Set-Cookie', 'a=1');
			}
		);

		const res = await fetchHttp(baseUrl, '/unavailable');

		assert.equal(res.status, 503);
		assert.equal(res.complete, true);
		assert.equal(res.body, 'Error: Service Unavailable');
		assert.equal(res.headers['retry-after'], '5');
		assert.equal(res.headers['cache-control'], 'no-store');
		assert.notEqual(res.headers['content-length'], '4096');
		assert.equal(res.headers.etag, undefined);
		assert.equal(res.headers['last-modified'], undefined);
		assert.equal(res.headers['x-frame-options'], 'DENY');
		assert.equal(res.headers.vary, 'Accept-Encoding');
		assert.deepEqual(res.headers['set-cookie'], ['a=1']);
	});

	it('answers send for a missing file with 404 and does not reveal the path', async () => {
		dispatch.current = (req) => ({
			handlesHeaders: true,
			body: send(req, 'missing.txt', { root: tempRoot }),
		});

		const res = await fetchHttp(baseUrl, '/missing');

		assert.equal(res.status, 404);
		assert.equal(res.body, 'Error: Not Found');
		assert.ok(!res.body.includes(tempRoot));
	});

	it('answers an error without a status with a generic 500 that does not reveal its message', async () => {
		dispatch.current = failing(
			Object.assign(new Error(`EACCES: permission denied, open '${tempRoot}/secret'`), { code: 'EACCES' })
		);

		const res = await fetchHttp(baseUrl, '/denied');

		assert.equal(res.status, 500);
		assert.equal(res.body, 'Error: Internal Server Error');
	});

	it('lets an error declare its own cache headers over the no-store default', async () => {
		dispatch.current = failing(
			Object.assign(new ClientError('gone', 410), { headers: { 'Cache-Control': 'public, max-age=60' } }),
			(res) => res.setHeader('Cache-Control', 'public, max-age=3600')
		);

		const res = await fetchHttp(baseUrl, '/cacheable-gone');

		assert.equal(res.status, 410);
		assert.equal(res.headers['cache-control'], 'public, max-age=60');
	});

	it('sends the message of a ClientError', async () => {
		dispatch.current = failing(new ClientError('no such part', 404));

		const res = await fetchHttp(baseUrl, '/client-error');

		assert.equal(res.status, 404);
		assert.equal(res.body, 'ClientError: no such part');
	});

	it('does not reveal the message of a status-bearing error that is not a ClientError', async () => {
		dispatch.current = failing(
			Object.assign(new Error(`Blob file not found for ${tempRoot}/blobs/1`), {
				name: 'BlobReadError',
				statusCode: 404,
			})
		);

		const res = await fetchHttp(baseUrl, '/blob-gone');

		assert.equal(res.status, 404);
		assert.equal(res.body, 'Error: Not Found');
	});

	it('writes a 416 with its Content-Range', async () => {
		dispatch.current = failing(
			Object.assign(new Error('Range Not Satisfiable'), { status: 416, headers: { 'Content-Range': 'bytes */5' } })
		);

		const res = await fetchHttp(baseUrl, '/range');

		assert.equal(res.status, 416);
		assert.equal(res.headers['content-range'], 'bytes */5');
	});

	it('answers a source that was destroyed with an error before it was piped', async () => {
		dispatch.current = () => {
			const body = new Readable({ read() {} });
			body.on('error', () => {});
			body.destroy(Object.assign(new Error('gone'), { statusCode: 410 }));
			return { handlesHeaders: true, body };
		};

		const res = await fetchHttp(baseUrl, '/gone');

		assert.equal(res.status, 410);
	});

	it('aborts the connection when it cannot write the error response', async () => {
		dispatch.current = failing(
			Object.assign(new Error('bad header'), { statusCode: 503, headers: { 'Retry-After': '5\r\nX-Injected: 1' } })
		);

		await assert.rejects(fetchHttp(baseUrl, '/unwritable'), /socket hang up/);
		dispatch.current = () => ({ status: 200, body: 'still serving' });
		assert.equal((await fetchHttp(baseUrl, '/after')).body, 'still serving');
	});

	it('serves the whole response when the source errors after it ended', async () => {
		const size = 32 * 1024 * 1024;
		let lateErrorEmitted = false;
		let finishedAtError;
		dispatch.current = (req) => {
			const body = new Readable({
				read() {
					this.push(Buffer.alloc(size, 97));
					this.push(null);
				},
			});
			// the response has ended but its body is still flushing, because the client has not read it yet
			body.on('end', () =>
				setImmediate(() => {
					finishedAtError = req._nodeResponse.writableFinished;
					lateErrorEmitted = true;
					body.emit('error', new Error('late'));
				})
			);
			return { handlesHeaders: true, body };
		};

		const res = await new Promise((resolve, reject) => {
			const request = http.get(`${baseUrl}/late-error`, { agent: false }, (response) => {
				response.pause();
				waitFor(() => lateErrorEmitted, {
					timeout: REQUEST_TIMEOUT_MS,
					message: 'timed out waiting for the late error',
				}).then(() => {
					let received = 0;
					const finish = (complete) => resolve({ status: response.statusCode, received, complete });
					response.on('data', (chunk) => (received += chunk.length));
					response.on('end', () => finish(response.complete));
					response.on('aborted', () => finish(false));
					response.on('error', () => finish(false));
					response.resume();
				}, reject);
			});
			request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('Request timed out')));
			request.on('error', reject);
		});

		assert.equal(finishedAtError, false, 'the late error must arrive while the response is still flushing');
		assert.equal(res.status, 200);
		assert.equal(res.received, size);
		assert.equal(res.complete, true);
	});

	it('aborts the connection when the source closes without ending or erroring', async () => {
		dispatch.current = () => {
			const body = new Readable({ read() {} });
			body.destroy();
			return { handlesHeaders: true, body };
		};

		await assert.rejects(fetchHttp(baseUrl, '/silent'), /socket hang up/);
		dispatch.current = () => ({ status: 200, body: 'still serving' });
		assert.equal((await fetchHttp(baseUrl, '/after')).body, 'still serving');
	});

	it('aborts the connection when the stream fails after the head is written', async () => {
		dispatch.current = () => {
			let sent = false;
			return {
				handlesHeaders: true,
				body: new Readable({
					read() {
						if (sent) return;
						sent = true;
						this.push('partial');
						// let the head and first chunk reach the client before the failure
						setTimeout(() => this.destroy(Object.assign(new Error('midstream'), { statusCode: 503 })), 50);
					},
				}),
			};
		};

		const res = await fetchHttp(baseUrl, '/midstream');

		assert.equal(res.status, 200);
		assert.equal(res.complete, false, 'a truncated body must not read as a complete response');
	});

	it('destroys the source when the client disconnects before the first byte', async () => {
		let sourceClosed = false;
		let requestStarted = false;
		dispatch.current = () => {
			requestStarted = true;
			const body = new Readable({ read() {} });
			body.on('close', () => {
				sourceClosed = true;
			});
			return { handlesHeaders: true, body };
		};

		const req = http.get(`${baseUrl}/slow`, { agent: false });
		req.on('error', () => {});
		await waitFor(() => requestStarted, {
			timeout: REQUEST_TIMEOUT_MS,
			message: 'timed out waiting for the handler to run',
		});
		req.destroy();
		await waitFor(() => sourceClosed, {
			timeout: REQUEST_TIMEOUT_MS,
			message: 'timed out waiting for the source to be destroyed',
		});
	});

	async function overHttp2(createBody) {
		const h2Server = http2.createServer((req, res) => {
			pipeBodyToResponse(createBody(), res, '/h2', 'GET', performance.now());
		});
		await new Promise((resolve) => h2Server.listen(0, '127.0.0.1', resolve));
		const client = http2.connect(`http://127.0.0.1:${h2Server.address().port}`);
		try {
			return await new Promise((resolve, reject) => {
				const stream = client.request({ ':path': '/h2' });
				const chunks = [];
				let status;
				const finish = (complete) => resolve({ status, complete, body: Buffer.concat(chunks).toString() });
				stream.on('response', (headers) => {
					status = headers[':status'];
				});
				stream.on('data', (chunk) => chunks.push(chunk));
				stream.on('end', () => finish(true));
				stream.on('error', () => finish(false));
				stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
					stream.destroy();
					reject(new Error('Request timed out'));
				});
			});
		} finally {
			client.close();
			h2Server.close();
		}
	}

	it('answers a stream error with a status over HTTP/2', async () => {
		const res = await overHttp2(
			() =>
				new Readable({
					read() {
						this.destroy(new ClientError('no such part', 404));
					},
				})
		);

		assert.equal(res.status, 404);
		assert.equal(res.body, 'ClientError: no such part');
	});

	it('aborts the stream when it fails after the head is written over HTTP/2', async () => {
		const res = await overHttp2(() => {
			let sent = false;
			return new Readable({
				read() {
					if (sent) return;
					sent = true;
					this.push('partial');
					setTimeout(() => this.destroy(new Error('midstream')), 50);
				},
			});
		});

		assert.equal(res.status, 200);
		assert.equal(res.complete, false);
	});

	// Metrics are reported per period and keyed by handler path, so each test claims its own path.
	const outcomesFor = (path) => reported.filter((outcome) => outcome.path === path);
	const withHandlerPath = (path, handler) => (req) => {
		req.handlerPath = path;
		return handler(req);
	};

	it('records the status that was sent, once', async () => {
		dispatch.current = withHandlerPath(
			'outcome-failed',
			failing(Object.assign(new Error('try later'), { statusCode: 503 }))
		);

		await fetchHttp(baseUrl, '/unavailable');
		await waitFor(() => outcomesFor('outcome-failed').length > 0, {
			timeout: REQUEST_TIMEOUT_MS,
			message: 'timed out waiting for the outcome to be reported',
		});

		assert.deepEqual(outcomesFor('outcome-failed'), [{ metric: 'response_503', path: 'outcome-failed', count: 1 }]);
	});

	it('records a served file once, with its own status', async () => {
		writeFileSync(join(tempRoot, 'ok.txt'), 'ok');
		dispatch.current = withHandlerPath('outcome-served', (req) => ({
			handlesHeaders: true,
			body: send(req, 'ok.txt', { root: tempRoot }),
		}));

		const res = await fetchHttp(baseUrl, '/ok');
		await waitFor(() => outcomesFor('outcome-served').length > 0, {
			timeout: REQUEST_TIMEOUT_MS,
			message: 'timed out waiting for the outcome to be reported',
		});

		assert.equal(res.status, 200);
		assert.equal(res.body, 'ok');
		assert.deepEqual(outcomesFor('outcome-served'), [{ metric: 'response_200', path: 'outcome-served', count: 1 }]);
	});

	it('leaves a stream whose head was already written on pipeline', async () => {
		dispatch.current = withHandlerPath('outcome-streamed', () => ({ status: 201, body: Readable.from(['a', 'b']) }));

		const res = await fetchHttp(baseUrl, '/streamed');
		await waitFor(() => outcomesFor('outcome-streamed').length > 0, {
			timeout: REQUEST_TIMEOUT_MS,
			message: 'timed out waiting for the outcome to be reported',
		});

		assert.equal(res.status, 201);
		assert.equal(res.body, 'ab');
		assert.deepEqual(outcomesFor('outcome-streamed'), [{ metric: 'response_201', path: 'outcome-streamed', count: 1 }]);
	});
});
