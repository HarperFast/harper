// Caller impact of application mounts on `server.http` routing: 79325af60..11d4d6406 (harper#1964), first
// released in v5.2.0. Before it, `host`/`urlPath` on an application's root-config entry were read by nothing
// (#1113's `deploy_component urlPath` persisted an inert value); since, they route every handler the
// application's plugins register through `scope.server`. Application module code (`import { server } from
// 'harper'`) gets the unmounted server and is not routed by the mount. A `v5.1.26:` comment gives that
// release's result for a shape that differed; v5.2.0 and main agree on every shape.
// Registration goes through the real `Scope` proxy and lands in the real router (`makeCallbackChain`, the
// builder `server/http.ts` uses for every port), so each test observes the route and the URL a handler sees.
const assert = require('node:assert');
const { join, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { stringify } = require('yaml');
const { Scope } = require('#src/components/Scope');
const { ApplicationScope } = require('#src/components/ApplicationScope');
const { Resources } = require('#src/resources/Resources');
const { Resource } = require('#src/resources/Resource');
const { makeCallbackChain } = require('#src/server/middlewareChain');
const { Request } = require('#src/server/serverHelpers/Request');
const { toScopeMount } = require('#src/components/scopeMount');
const { waitFor } = require('../waitFor.js');
const { server } = require('#src/server/Server');
const httpModule = require('#src/server/http');
const { describeMiddlewareChains } = httpModule;
const { handleApplication: handleRest } = require('#src/server/REST');
const { handleApplication: handleFastifyRoutes } = require('#src/server/fastifyRoutes');
const { loadComponent, loadedPaths, TRUSTED_RESOURCE_PLUGINS } = require('#src/components/componentLoader');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

const PORT = 'mount-caller-impact';

const passThrough = (request, next) => next(request);

// Node's HTTP/2 compatibility layer sends no Host header; it exposes `:authority` as `request.authority`.
function request(url, { host = 'localhost:9926', http2 = false } = {}) {
	const nodeRequest = http2
		? { method: 'GET', url, authority: host, headers: { ':authority': host } }
		: { method: 'GET', url, headers: { host } };
	return new Request(nodeRequest);
}

// Entries are what `server.http(listener, options)` records; `server/http.ts` builds each port's chain this way.
function dispatch(entries, req) {
	const chain = makeCallbackChain(
		entries.map((entry) => ({ ...entry, port: PORT })),
		PORT,
		() => 'unhandled'
	);
	return chain(req);
}

function answering(name, extra = () => ({})) {
	return (req) => ({ name, url: req.url, pathname: req.pathname, ...extra(req) });
}

describe('server.http under application mounts: caller impact', () => {
	let directory;
	let configFilePath;
	const appName = 'mount-caller-impact-app';
	const pluginName = 'probe';
	const openScopes = [];

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'harper.unit-test.mount-caller-impact-'));
		configFilePath = join(directory, 'config.yaml');
	});

	afterEach(async () => {
		await Promise.all(openScopes.splice(0).map((scope) => scope.close()));
		await new Promise((resolve) => setImmediate(resolve));
		rmSync(directory, { recursive: true, force: true });
	});

	async function registerThroughScope(pluginConfig, mount, listener, options) {
		writeFileSync(configFilePath, stringify({ [pluginName]: pluginConfig }));
		let entry;
		const capturingServer = { http: (registered, injected) => (entry = { listener: registered, ...injected }) };
		const scope = new Scope(
			appName,
			pluginName,
			directory,
			configFilePath,
			new ApplicationScope(appName, new Resources(), capturingServer),
			undefined,
			undefined,
			mount
		);
		openScopes.push(scope);
		await scope.ready;
		scope.server.http(listener, options);
		return entry;
	}

	describe('no mount configured (the default)', () => {
		it('a root-config application entry without host/urlPath declares no mount', () => {
			for (const entry of [undefined, null, {}, { package: '@my/app' }, { urlPath: '/' }, { urlPath: '' }]) {
				assert.strictEqual(toScopeMount(entry), undefined, JSON.stringify(entry));
			}
		});

		it('scope.server.http(handler): unrouted, the handler sees the full URL, as before', async () => {
			const entry = await registerThroughScope({ files: '*.js' }, undefined, answering('scoped'));
			assert.strictEqual(entry.urlPath, undefined);
			assert.strictEqual(entry.host, undefined);
			assert.deepStrictEqual(dispatch([entry], request('/v1/thing?x=1')), {
				name: 'scoped',
				url: '/v1/thing?x=1',
				pathname: '/v1/thing',
			});
		});

		it('scope.server.http(handler) with a plugin-config urlPath: routed under it, prefix stripped, as before', async () => {
			const entry = await registerThroughScope({ urlPath: 'api' }, undefined, answering('scoped'));
			assert.strictEqual(entry.urlPath, '/api/');
			assert.deepStrictEqual(dispatch([entry], request('/api/thing?x=1')), {
				name: 'scoped',
				url: '/thing?x=1',
				pathname: '/thing',
			});
			assert.strictEqual(dispatch([entry], request('/thing')), 'unhandled');
		});

		it('scope.server.http(handler, { urlPath: "api" }): same route as before', async () => {
			// v5.1.26 registered the raw 'api' and this resolves it to '/api/'; the router normalizes both to '/api'.
			const entry = await registerThroughScope({}, undefined, answering('scoped'), { urlPath: 'api' });
			assert.strictEqual(dispatch([entry], request('/api/thing')).pathname, '/thing');
			assert.strictEqual(dispatch([entry], request('/thing')), 'unhandled');
		});

		it('scope.server.http(handler, { urlPath: "./x" }): namespaced under the plugin name', async () => {
			// v5.1.26: passed through raw; the router built the route '/./x'. Browsers and fetch remove '.' segments
			// before sending, so only a client sending the raw path (curl --path-as-is) reached it. Changed by 79325af60.
			const entry = await registerThroughScope({}, undefined, answering('scoped'), { urlPath: './x' });
			assert.strictEqual(entry.urlPath, `/${pluginName}/x/`);
			assert.strictEqual(dispatch([entry], request(`/${pluginName}/x/thing`)).pathname, '/thing');
		});

		it('scope.server.http(handler, { urlPath: undefined }) with a plugin-config urlPath: the config path applies', async () => {
			// v5.1.26: an explicit `urlPath: undefined` overrode the config value, so the handler was unrouted
			// and saw '/api/thing'. Since 79325af60 an undefined option falls back to config (`??`).
			const entry = await registerThroughScope({ urlPath: 'api' }, undefined, answering('scoped'), {
				urlPath: undefined,
			});
			assert.strictEqual(entry.urlPath, '/api/');
			assert.strictEqual(dispatch([entry], request('/api/thing')).pathname, '/thing');
		});

		it('scope.server.http(handler, { urlPath: "../x" }): throws at registration', async () => {
			// v5.1.26: registered the route '/../x'. Changed by 79325af60.
			await assert.rejects(
				registerThroughScope({}, undefined, answering('scoped'), { urlPath: '../x' }),
				/urlPath must not contain '\.\.'/
			);
		});

		it('scope.server.http(handler, { port }): the port passes through and nothing else is routed, as before', async () => {
			const entry = await registerThroughScope({}, undefined, answering('scoped'), { port: 9999 });
			assert.strictEqual(entry.port, 9999);
			assert.strictEqual(entry.urlPath, undefined);
			assert.strictEqual(entry.host, undefined);
		});

		it('host-routed handler: matches the Host header case-insensitively', () => {
			// v5.1.26: an exact, case-sensitive compare of the Host header minus its port, so 'API.Example.com'
			// never matched the lowercased host clients send. Changed by b9f99b1a5.
			const entry = { name: 'hosted', listener: answering('hosted'), host: 'API.Example.com' };
			assert.strictEqual(dispatch([entry], request('/', { host: 'api.example.com:9926' })).name, 'hosted');
		});

		it('host-routed handler: matches an HTTP/2 request by its :authority', () => {
			// v5.1.26: read only the Host header, which HTTP/2 clients do not send, so every HTTP/2 request
			// fell through to the default chain. Changed by 39ecddd52.
			const entry = { name: 'hosted', listener: answering('hosted'), host: 'api.example.com' };
			assert.strictEqual(dispatch([entry], request('/', { host: 'api.example.com', http2: true })).name, 'hosted');
		});

		it('host-routed handler: matches a trailing-dot or bracketed-IPv6 Host header', () => {
			// v5.1.26: neither matched ('api.example.com.' compared unequal; '[::1]:9926' split on the first ':').
			// Changed by b9f99b1a5 (IPv6) and 39ecddd52 (trailing dot).
			const named = { name: 'hosted', listener: answering('hosted'), host: 'api.example.com' };
			assert.strictEqual(dispatch([named], request('/', { host: 'api.example.com.' })).name, 'hosted');
			const ipv6 = { name: 'hosted', listener: answering('hosted'), host: '::1' };
			assert.strictEqual(dispatch([ipv6], request('/', { host: '[::1]:9926' })).name, 'hosted');
		});

		it('two routed handlers: `after` no longer pulls in a handler registered under a different route', () => {
			// v5.1.26: `after` resolved against every route's registrations, first wins, so 'audit' (registered
			// only under '/b') was spliced into the '/a' chain and ran on '/a' requests. Since ef13e94c1 a routed
			// entry resolves `after` only against its own route and the unrouted entries.
			const seen = [];
			const audit = {
				name: 'audit',
				urlPath: '/b',
				listener: (req, next) => (seen.push('audit'), next(req)),
			};
			const handler = { name: 'handler', urlPath: '/a', after: 'audit', listener: answering('handler') };
			assert.strictEqual(dispatch([audit, handler], request('/a/x')).name, 'handler');
			assert.deepStrictEqual(seen, []);
		});
	});

	describe('mount configured in the root config', () => {
		it('scope.server.http(handler): routed under the mount; the handler sees the mount-relative URL', async () => {
			// v5.1.26: the root-config `urlPath` was inert, so the same app answered '/thing' and its handler saw
			// '/v1/thing' as an ordinary unrouted path.
			const entry = await registerThroughScope(
				{ files: '*.js' },
				{ urlPath: '/v1' },
				answering('scoped', (req) => ({ originalPathname: req.originalPathname }))
			);
			assert.strictEqual(entry.urlPath, '/v1/');
			assert.deepStrictEqual(dispatch([entry], request('/v1/thing?x=1')), {
				name: 'scoped',
				url: '/thing?x=1',
				pathname: '/thing',
				originalPathname: '/v1/thing',
			});
			assert.strictEqual(dispatch([entry], request('/thing')), 'unhandled');
		});

		it('scope.server.http(handler) with a plugin-config urlPath: mount and plugin path compose', async () => {
			const entry = await registerThroughScope({ urlPath: 'assets' }, { urlPath: '/v1' }, answering('scoped'));
			assert.strictEqual(entry.urlPath, '/v1/assets/');
			assert.strictEqual(dispatch([entry], request('/v1/assets/a.css')).pathname, '/a.css');
			assert.strictEqual(dispatch([entry], request('/assets/a.css')), 'unhandled');
		});

		it('scope.server.http(handler) under a host mount: answers only that host, path untouched', async () => {
			const entry = await registerThroughScope({}, { host: 'api.example.com' }, answering('scoped'));
			assert.strictEqual(entry.host, 'api.example.com');
			assert.strictEqual(entry.urlPath, undefined);
			assert.strictEqual(dispatch([entry], request('/x', { host: 'api.example.com' })).pathname, '/x');
			assert.strictEqual(dispatch([entry], request('/x', { host: 'other.example.com' })), 'unhandled');
		});

		it('scope.server.http(handler, { host, urlPath }): the mount host replaces the option, the paths compose', async () => {
			const entry = await registerThroughScope({}, { host: 'api.example.com', urlPath: '/v1' }, answering('scoped'), {
				host: 'www.example.com',
				urlPath: 'hooks',
			});
			assert.strictEqual(entry.host, 'api.example.com');
			assert.strictEqual(entry.urlPath, '/v1/hooks/');
		});

		it('scope.server.http(handler, { port }): still constrained to the mount on that port', async () => {
			// v5.1.26: answered every path on the dedicated port.
			const entry = await registerThroughScope({}, { urlPath: '/v1' }, answering('scoped'), { port: 9999 });
			assert.strictEqual(entry.port, 9999);
			assert.strictEqual(dispatch([entry], request('/v1/thing')).pathname, '/thing');
			assert.strictEqual(dispatch([entry], request('/thing')), 'unhandled');
		});

		it('unrouted server.http(handler) middleware does not run for requests the mounted route answers', () => {
			// The default chain runs only when no routed chain matches. v5.1.26 behaved the same for a route built
			// from a plugin-config urlPath; what is new is that a root-config mount now creates such a route.
			const seen = [];
			const logger = { name: 'requestLogger', listener: (req, next) => (seen.push(req.url), next(req)) };
			const mounted = { name: 'rest', urlPath: '/v1/', listener: answering('rest') };
			assert.strictEqual(dispatch([logger, mounted], request('/v1/Thing')).name, 'rest');
			assert.deepStrictEqual(seen, []);
			assert.strictEqual(dispatch([logger, mounted], request('/other')), 'unhandled');
			assert.deepStrictEqual(seen, ['/other']);
		});

		it('unrouted middleware that a mounted handler names in `after` runs inside the mount, seeing stripped URLs', () => {
			const seen = [];
			const logger = { name: 'requestLogger', listener: (req, next) => (seen.push(req.url), next(req)) };
			const mounted = { name: 'rest', urlPath: '/v1/', after: 'requestLogger', listener: answering('rest') };
			assert.strictEqual(dispatch([logger, mounted], request('/v1/Thing')).name, 'rest');
			assert.deepStrictEqual(seen, ['/Thing']);
		});

		it('invalid mount values throw at parse, which tryRootConfigMount turns into skipping the application', () => {
			// v5.1.26: these values were inert and the application loaded at '/'.
			assert.throws(() => toScopeMount({ host: 'api.example.com:9926' }), /bare hostname/);
			assert.throws(() => toScopeMount({ host: 9926 }), /bare hostname/);
			assert.throws(() => toScopeMount({ urlPath: './v1' }), /absolute path/);
			assert.throws(() => toScopeMount({ urlPath: '../v1' }), /must not contain/);
		});
	});

	describe('application module code (`import { server } from "harper"`)', () => {
		const probePort = 19520;
		let componentDir;

		afterEach(() => {
			delete TRUSTED_RESOURCE_PLUGINS.mountCallerImpactProbe;
			loadedPaths.clear();
			if (componentDir) rmSync(componentDir, { recursive: true, force: true });
		});

		it('gets the bare server: its handlers stay unrouted while the application plugins move under the mount', async () => {
			const tag = randomUUID().slice(0, 8);
			componentDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.mount-caller-impact-app-'));
			writeFileSync(
				join(componentDir, 'config.yaml'),
				stringify({ mountCallerImpactProbe: { files: '*.txt' }, jsResource: { files: 'resources.js' } })
			);
			writeFileSync(join(componentDir, 'probe.txt'), '');
			writeFileSync(
				join(componentDir, 'resources.js'),
				`import { server } from 'harper';\n` +
					`server.http((request, next) => next(request), { port: ${probePort}, name: 'module-${tag}' });\n`
			);
			TRUSTED_RESOURCE_PLUGINS.mountCallerImpactProbe = {
				handleApplication(scope) {
					scope.server.http(passThrough, { port: probePort, name: `scoped-${tag}` });
				},
			};
			await loadComponent(componentDir, Object.assign(new Resources(), { isWorker: true }), 'test-origin', {
				appName: basename(componentDir),
				mount: { urlPath: '/v1' },
			});

			const routeOf = (name) =>
				(describeMiddlewareChains().http[probePort] ?? []).find((route) => route.order.includes(name));
			await waitFor(() => routeOf(`module-${tag}`) && routeOf(`scoped-${tag}`), {
				timeout: 5000,
				message: 'resources.js or the probe plugin never registered',
			});
			assert.strictEqual(routeOf(`scoped-${tag}`).urlPath, '/v1');
			assert.strictEqual(routeOf(`module-${tag}`).urlPath, undefined);
			assert.strictEqual(routeOf(`module-${tag}`).host, undefined);
		});
	});

	describe('root-config `package` entry with a urlPath', () => {
		let packageDir;

		afterEach(() => {
			loadedPaths.clear();
			if (packageDir) rmSync(packageDir, { recursive: true, force: true });
		});

		it('a package that ships no config file loads the default plugins, REST included, under the mount', async () => {
			// The loader hands the entry's own host/urlPath to the package directory's load as its mount, and a
			// directory without a config file loads DEFAULT_CONFIG (`rest: true`, `static`, ...). REST registers
			// once per resolved route, so the mount adds a second REST route serving every exported resource.
			// v5.1.26: the same plugins registered unrouted, where REST had already registered once per process.
			packageDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.mount-caller-impact-pkg-'));
			writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'mount-caller-impact-pkg' }));
			const urlPath = `/pkg-${randomUUID().slice(0, 8)}`;
			const registered = [];
			const originalHttp = server.http;
			server.http = (listener, options) => registered.push(options);
			try {
				await loadComponent(packageDir, Object.assign(new Resources(), { isWorker: true }), 'test-origin', {
					appName: 'mount-caller-impact-pkg',
					mount: { urlPath },
				});
			} finally {
				server.http = originalHttp;
			}
			assert.deepStrictEqual(
				registered.map(({ name, urlPath }) => ({ name, urlPath })),
				[
					{ name: 'rest', urlPath: `${urlPath}/` },
					{ name: 'static', urlPath: `${urlPath}/` },
				]
			);
		});
	});

	describe('REST (`rest:` plugin)', () => {
		class LastModifiedProbe extends Resource {
			static get(target, request) {
				request.lastModified = Date.UTC(2026, 0, 1);
				return { ok: true };
			}
		}

		function restScope(options, routeFor, registered) {
			const resources = new Resources();
			resources.set('LastModifiedProbe', LastModifiedProbe);
			return {
				resources,
				options: { getAll: () => options },
				routeFor,
				server: { http: (listener, opts) => registered.push({ listener, opts }), ws: () => [] },
			};
		}

		async function get(listener) {
			const headerObject = {};
			return listener(
				{
					method: 'GET',
					url: '/LastModifiedProbe/1',
					pathname: '/LastModifiedProbe/1',
					headers: { asObject: headerObject, get: (name) => headerObject[name.toLowerCase()] },
				},
				() => assert.fail('no resource matched')
			);
		}

		it('a resource under a mounted REST route reads its request URL mount-relative', async () => {
			// v5.1.26: the root-config mount was inert, so the resource answered '/ContextUrlProbe/1' and read that.
			class ContextUrlProbe extends Resource {
				static get(target, request) {
					return { url: request.url, pathname: request.pathname, originalPathname: request.originalPathname };
				}
			}
			const registered = [];
			const urlPath = `/v-${randomUUID().slice(0, 8)}/`;
			const scope = restScope({ webSocket: false }, () => ({ urlPath }), registered);
			scope.resources.set('ContextUrlProbe', ContextUrlProbe);
			handleRest(scope);
			const url = `${urlPath}ContextUrlProbe/1?x=1`;
			const headerObject = {};
			const response = await dispatch([{ name: 'rest', urlPath, listener: registered[0].listener }], {
				method: 'GET',
				url,
				pathname: url.split('?')[0],
				headers: { asObject: headerObject, get: (name) => headerObject[name.toLowerCase()] },
			});
			const chunks = [];
			for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
			assert.deepStrictEqual(JSON.parse(Buffer.concat(chunks).toString()), {
				url: '/ContextUrlProbe/1?x=1',
				pathname: '/ContextUrlProbe/1',
				originalPathname: `${urlPath}ContextUrlProbe/1`,
			});
		});

		it('two applications mounted at different paths each get a REST chain', () => {
			// v5.1.26: REST registered once per process; the second application's REST API 404'd.
			const registered = [];
			const id = randomUUID();
			handleRest(restScope({ webSocket: false }, () => ({ urlPath: `/a-${id}/` }), registered));
			handleRest(restScope({ webSocket: false }, () => ({ urlPath: `/b-${id}/` }), registered));
			assert.strictEqual(registered.length, 2);
		});

		it('two applications on the same route: the first registration options govern', async () => {
			// v5.1.26: each handleApplication call overwrote one module-level options object before the
			// once-per-process check, so the LAST application loaded set `lastModified`/`exactCount` for every
			// REST request. Since b9f99b1a5 the first registration on a route keeps its own options. Which
			// application loads first is not fixed: the loader starts every components-root app concurrently.
			const control = [];
			handleRest(
				restScope({ webSocket: false, lastModified: true }, () => ({ urlPath: `/c-${randomUUID()}/` }), control)
			);
			assert.ok((await get(control[0].listener)).headers.get('Last-Modified'), 'lastModified alone sets the header');

			const registered = [];
			const route = { urlPath: `/same-${randomUUID()}/` };
			handleRest(restScope({ webSocket: false }, () => route, registered));
			handleRest(restScope({ webSocket: false, lastModified: true }, () => route, registered));
			assert.strictEqual(registered.length, 1);
			const response = await get(registered[0].listener);
			assert.strictEqual(response.status, 200);
			assert.strictEqual(response.headers.get('Last-Modified'), undefined);
		});
	});

	describe('fastifyRoutes (`routes/*.js` legacy plugin)', () => {
		let fastifyDir;

		after(() => {
			if (fastifyDir) rmSync(fastifyDir, { recursive: true, force: true });
		});

		function fastifyScope(appName, mount, onEntry = () => {}) {
			return { appName, mount, options: { getAll: () => ({}) }, handleEntry: onEntry, requestRestart() {} };
		}

		it('an application without a mount: the plugin loads', () => {
			assert.doesNotThrow(() => handleFastifyRoutes(fastifyScope('fastify-app', undefined)));
		});

		it('an application with a host mount: the plugin refuses to load', () => {
			// v5.1.26: no mount existed; fastify routes answered on every host. The rest of the application
			// still loads: the loader contains a plugin's throw to that plugin.
			assert.throws(
				() => handleFastifyRoutes(fastifyScope('fastify-app', { host: 'api.example.com' })),
				/cannot be constrained by host/
			);
		});

		it('an application with only a urlPath mount serves its fastify routes under the mount', async () => {
			// v5.1.26: the mount was inert, so this route answered at '/hello'. Fastify registers on the bare
			// server, so nothing strips the mount: the route prefix carries it. The process builds one fastify
			// app and its routes are fixed once it boots, so this file exercises a single route folder.
			fastifyDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.mount-caller-impact-fastify-'));
			mkdirSync(join(fastifyDir, 'routes'));
			const fastifyConfig = join(fastifyDir, 'config.yaml');
			writeFileSync(fastifyConfig, stringify({ fastifyRoutes: { files: 'routes/*.js' } }));
			writeFileSync(
				join(fastifyDir, 'routes', 'hello.js'),
				`module.exports = async (server) => server.get('/hello', async () => ({ ok: true }));`
			);
			const scope = new Scope(
				basename(fastifyDir),
				'fastifyRoutes',
				fastifyDir,
				fastifyConfig,
				new ApplicationScope(basename(fastifyDir), new Resources(), server),
				undefined,
				undefined,
				{ urlPath: '/v1' }
			);
			openScopes.push(scope);
			await scope.ready;
			let fastifyApp;
			const originalRegister = httpModule.registerFastifyInstance;
			httpModule.registerFastifyInstance = (port, instance) => (fastifyApp = instance);
			// the app is handed over once per configured http port, so there must be one
			const configuredPort = env.get(CONFIG_PARAMS.HTTP_PORT);
			if (configuredPort == null) env.setProperty(CONFIG_PARAMS.HTTP_PORT, 19521);
			try {
				handleFastifyRoutes(scope);
				await waitFor(() => fastifyApp, { timeout: 10000, message: 'the fastify app was never registered' });
				// the entry handler registers the route folder after it has handed the app to the port
				await scope.waitForInitialLoads();
			} finally {
				httpModule.registerFastifyInstance = originalRegister;
				if (configuredPort == null) env.setProperty(CONFIG_PARAMS.HTTP_PORT, configuredPort);
			}
			assert.ok(fastifyApp, 'the fastify app was registered for the http port');
			assert.strictEqual((await fastifyApp.inject({ method: 'GET', url: '/v1/hello' })).statusCode, 200);
			assert.strictEqual((await fastifyApp.inject({ method: 'GET', url: '/hello' })).statusCode, 404);
		});
	});
});
