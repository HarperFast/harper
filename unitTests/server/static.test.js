const { serveStatic, handleApplication } = require('#src/server/static');
const { Scope } = require('#src/components/Scope');
const { ApplicationScope } = require('#src/components/ApplicationScope');
const { Resources } = require('#src/resources/Resources');
const assert = require('node:assert/strict');
const { join, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { stringify } = require('yaml');

// Exercise the public `serveStatic` helper against a real Scope (with a fake server that
// records http registrations) and a real on-disk directory watched by a real EntryHandler.
// This covers matchStaticFile + respondWithFile + the cache/header wiring end-to-end without
// standing up the HTTP server.
describe('serveStatic', () => {
	let directory;
	let scope;
	let httpCalls;

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), 'harper.unit-test.serveStatic-'));
		// A small static tree to serve.
		writeFileSync(join(directory, 'index.html'), '<h1>home</h1>');
		writeFileSync(join(directory, 'page.html'), '<h1>page</h1>');
		mkdirSync(join(directory, 'assets'));
		writeFileSync(join(directory, 'assets', 'app-abc123.js'), 'console.log(1)');
		mkdirSync(join(directory, 'sub'));
		writeFileSync(join(directory, 'sub', 'index.html'), '<h1>sub</h1>');

		httpCalls = [];
		const fakeServer = {
			http: (listener, options) => {
				httpCalls.push({ listener, options });
			},
		};

		// serveStatic ignores scope.options, but the Scope's OptionsWatcher needs a valid
		// config to become ready.
		const configFilePath = join(directory, 'config.yaml');
		writeFileSync(configFilePath, stringify({ plugin: { files: '**' } }));

		const appName = basename(directory);
		scope = new Scope(
			appName,
			'plugin',
			directory,
			configFilePath,
			new ApplicationScope('test', new Resources(), fakeServer)
		);
		await scope.ready;
	});

	afterEach(async () => {
		await scope.close();
		// Let chokidar teardown + any pending file reads settle before removing the temp dir.
		await new Promise((resolve) => setImmediate(resolve));
		try {
			rmSync(directory, { recursive: true, force: true });
			// eslint-disable-next-line sonarjs/no-ignored-exceptions
		} catch {
			// best effort cleanup of a temp directory
		}
	});

	it('registers an http responder with the configured before/urlPath and serves a matched file', async () => {
		const entryHandler = serveStatic(scope, { directory, urlPath: '/', before: 'authentication' });
		await entryHandler.ready;

		assert.equal(httpCalls.length, 1);
		assert.equal(httpCalls[0].options.before, 'authentication');
		assert.equal(httpCalls[0].options.urlPath, '/');

		const responder = httpCalls[0].listener;
		const result = responder({ method: 'GET', pathname: '/assets/app-abc123.js' }, () => 'NEXT');
		assert.equal(result.handlesHeaders, true);
		assert.ok(result.body, 'expected a send stream body');
	});

	it('serves the directory index for the root path', async () => {
		const entryHandler = serveStatic(scope, { directory, urlPath: '/' });
		await entryHandler.ready;

		const responder = httpCalls[0].listener;
		const result = responder({ method: 'GET', pathname: '/' }, () => 'NEXT');
		assert.equal(result.handlesHeaders, true);
	});

	it('301-redirects a directory request to its trailing-slash form', async () => {
		const entryHandler = serveStatic(scope, { directory, urlPath: '/' });
		await entryHandler.ready;

		const responder = httpCalls[0].listener;
		const result = responder({ method: 'GET', pathname: '/sub' }, () => 'NEXT');
		assert.equal(result.status, 301);
		assert.equal(result.headers.Location, '/sub/');
	});

	it('matches files via the extensions fallback', async () => {
		const entryHandler = serveStatic(scope, { directory, urlPath: '/', extensions: ['html'] });
		await entryHandler.ready;

		const responder = httpCalls[0].listener;
		const result = responder({ method: 'GET', pathname: '/page' }, () => 'NEXT');
		assert.equal(result.handlesHeaders, true);
	});

	it('falls through to next when no file matches and fallthrough is true', async () => {
		const entryHandler = serveStatic(scope, { directory, urlPath: '/' });
		await entryHandler.ready;

		const responder = httpCalls[0].listener;
		let nextCalled = false;
		const result = responder({ method: 'GET', pathname: '/missing' }, () => {
			nextCalled = true;
			return 'NEXT';
		});
		assert.equal(nextCalled, true);
		assert.equal(result, 'NEXT');
	});

	it('returns 404 when no file matches and fallthrough is false', async () => {
		const entryHandler = serveStatic(scope, { directory, urlPath: '/', fallthrough: false });
		await entryHandler.ready;

		const responder = httpCalls[0].listener;
		const result = responder({ method: 'GET', pathname: '/missing' }, () => 'NEXT');
		assert.equal(result.status, 404);
		assert.equal(result.body, 'File not found');
	});

	it('serves a custom notFound file with the configured status code', async () => {
		writeFileSync(join(directory, '404.html'), 'nope');
		const entryHandler = serveStatic(scope, {
			directory,
			urlPath: '/',
			fallthrough: false,
			notFound: { file: '404.html', statusCode: 404 },
		});
		await entryHandler.ready;

		const responder = httpCalls[0].listener;
		const result = responder({ method: 'GET', pathname: '/missing' }, () => 'NEXT');
		assert.equal(result.status, 404);
		assert.equal(result.handlesHeaders, true);
	});

	it('passes non-GET requests through to the next handler', async () => {
		const entryHandler = serveStatic(scope, { directory, urlPath: '/' });
		await entryHandler.ready;

		const responder = httpCalls[0].listener;
		let nextCalled = false;
		responder({ method: 'POST', pathname: '/index.html' }, () => {
			nextCalled = true;
		});
		assert.equal(nextCalled, true);
	});

	it('applies a full cacheControl value, with setHeaders taking final precedence per file', async () => {
		const entryHandler = serveStatic(scope, {
			directory,
			urlPath: '/',
			cacheControl: 'public, max-age=31536000, immutable',
			setHeaders: (res, pathname) => {
				if (pathname.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
			},
		});
		await entryHandler.ready;
		const responder = httpCalls[0].listener;

		// Content-hashed asset keeps the immutable cacheControl value.
		const assetResult = responder({ method: 'GET', pathname: '/assets/app-abc123.js' }, () => 'NEXT');
		const assetHeaders = emitHeaders(assetResult.body, join(directory, 'assets', 'app-abc123.js'));
		assert.equal(assetHeaders['Cache-Control'], 'public, max-age=31536000, immutable');

		// index.html is overridden to no-cache by setHeaders (runs last).
		const indexResult = responder({ method: 'GET', pathname: '/' }, () => 'NEXT');
		const indexHeaders = emitHeaders(indexResult.body, join(directory, 'index.html'));
		assert.equal(indexHeaders['Cache-Control'], 'no-cache');
	});

	it('does not attach a headers listener when no cache options are provided', async () => {
		const entryHandler = serveStatic(scope, { directory, urlPath: '/' });
		await entryHandler.ready;
		const responder = httpCalls[0].listener;
		const result = responder({ method: 'GET', pathname: '/assets/app-abc123.js' }, () => 'NEXT');
		// No 'headers' listener means send's own default cache-control logic is untouched.
		assert.equal(result.body.listenerCount('headers'), 0);
	});
});

// The config-driven plugin entry point reads its options live from `scope.options`, including
// the additive cache options. This verifies the YAML path is unchanged and that
// maxAge/immutable/cacheControl flow through.
describe('static plugin (config-driven handleApplication)', () => {
	let directory;
	let scope;
	let httpCalls;

	function startWithConfig(staticConfig) {
		directory = mkdtempSync(join(tmpdir(), 'harper.unit-test.static-'));
		writeFileSync(join(directory, 'index.html'), '<h1>home</h1>');
		mkdirSync(join(directory, 'assets'));
		writeFileSync(join(directory, 'assets', 'app-abc123.js'), 'console.log(1)');

		httpCalls = [];
		const fakeServer = {
			http: (listener, options) => {
				httpCalls.push({ listener, options });
			},
		};
		const configFilePath = join(directory, 'config.yaml');
		writeFileSync(configFilePath, stringify({ plugin: { files: '**', ...staticConfig } }));
		scope = new Scope(
			basename(directory),
			'plugin',
			directory,
			configFilePath,
			new ApplicationScope('test', new Resources(), fakeServer)
		);
	}

	afterEach(async () => {
		await scope.close();
		await new Promise((resolve) => setImmediate(resolve));
		try {
			rmSync(directory, { recursive: true, force: true });
			// eslint-disable-next-line sonarjs/no-ignored-exceptions
		} catch {
			// best effort cleanup of a temp directory
		}
	});

	it('serves files watched via the default (files-driven) entry handler', async () => {
		startWithConfig({});
		await scope.ready;
		handleApplication(scope);
		await scope.waitForInitialLoads();

		assert.equal(httpCalls.length, 1);
		const responder = httpCalls[0].listener;
		const result = responder({ method: 'GET', pathname: '/assets/app-abc123.js' }, () => 'NEXT');
		assert.equal(result.handlesHeaders, true);
		// With no cache config, no headers listener is attached (send default preserved).
		assert.equal(result.body.listenerCount('headers'), 0);
	});

	it('applies a cacheControl value read live from config', async () => {
		startWithConfig({ cacheControl: 'public, max-age=31536000, immutable' });
		await scope.ready;
		handleApplication(scope);
		await scope.waitForInitialLoads();

		const responder = httpCalls[0].listener;
		const result = responder({ method: 'GET', pathname: '/assets/app-abc123.js' }, () => 'NEXT');
		const headers = emitHeaders(result.body, join(directory, 'assets', 'app-abc123.js'));
		assert.equal(headers['Cache-Control'], 'public, max-age=31536000, immutable');
	});

	it('honors before from config when registering the http handler', async () => {
		startWithConfig({ before: 'authentication' });
		await scope.ready;
		handleApplication(scope);
		await scope.waitForInitialLoads();

		assert.equal(httpCalls[0].options.before, 'authentication');
	});
});

// Drive the send stream's 'headers' event with a fake response to observe what headers the
// cache wiring sets. (send emits 'headers' before applying its own Cache-Control.)
function emitHeaders(body, pathname) {
	const headers = {};
	const fakeRes = {
		setHeader: (key, value) => {
			headers[key] = value;
		},
		getHeader: (key) => headers[key],
	};
	body.emit('headers', fakeRes, pathname, {});
	return headers;
}
