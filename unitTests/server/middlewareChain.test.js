'use strict';
const assert = require('assert');
const {
	topoSort,
	buildLinearChain,
	resolveDeps,
	matchesRoute,
	normalizeUrlPath,
	stripPrefix,
	makeCallbackChain,
	describeChains,
	resolveRoutedChains,
	findUnresolvedOrderingRefs,
} = require('#src/server/middlewareChain');

// Helpers ------------------------------------------------------------------

/** Minimal fallback used as the terminal `next` in all chain tests. */
const UNHANDLED = () => ({ status: -1 });

/** Build a minimal HttpEntry. port defaults to 9000. */
function entry(name, opts = {}) {
	return { listener: opts.listener ?? ((_req, next) => next(_req)), port: opts.port ?? 9000, name, ...opts };
}

/** Build a simple request object. */
function req(pathname = '/', host = undefined, url = undefined) {
	return { pathname, url: url ?? pathname, headers: { asObject: host ? { host } : {} } };
}

// --------------------------------------------------------------------------
// topoSort
// --------------------------------------------------------------------------

describe('topoSort', () => {
	it('returns empty array unchanged', () => {
		assert.deepStrictEqual(topoSort([]), []);
	});

	it('returns single element unchanged', () => {
		const e = entry('a');
		assert.deepStrictEqual(topoSort([e]), [e]);
	});

	it('preserves registration order when no constraints', () => {
		const [a, b, c] = ['a', 'b', 'c'].map((n) => entry(n));
		const sorted = topoSort([a, b, c]);
		assert.deepStrictEqual(
			sorted.map((e) => e.name),
			['a', 'b', 'c']
		);
	});

	it('enforces `before` constraint', () => {
		const a = entry('a');
		const b = entry('b', { before: 'a' }); // b must come before a
		// registered order: a, b  → sort should give b, a
		const sorted = topoSort([a, b]);
		assert.deepStrictEqual(
			sorted.map((e) => e.name),
			['b', 'a']
		);
	});

	it('enforces `after` constraint', () => {
		const a = entry('a', { after: 'b' }); // a must come after b
		const b = entry('b');
		// registered order: a, b → sort should give b, a
		const sorted = topoSort([a, b]);
		assert.deepStrictEqual(
			sorted.map((e) => e.name),
			['b', 'a']
		);
	});

	it('preserves config order as tiebreaker: auth before rest when both unconstrained', () => {
		const auth = entry('authentication');
		const rest = entry('rest', { after: 'authentication' });
		const staticE = entry('static');
		// config: static, authentication, rest
		const sorted = topoSort([staticE, auth, rest]);
		assert.deepStrictEqual(
			sorted.map((e) => e.name),
			['static', 'authentication', 'rest']
		);
	});

	it('config: rest, authentication, static → auth pulled before rest', () => {
		const rest = entry('rest', { after: 'authentication' });
		const auth = entry('authentication');
		const staticE = entry('static');
		// registered: rest(0), authentication(1), static(2)
		// constraint: auth before rest → expected: authentication, rest, static
		const sorted = topoSort([rest, auth, staticE]);
		const names = sorted.map((e) => e.name);
		const authIdx = names.indexOf('authentication');
		const restIdx = names.indexOf('rest');
		assert.ok(authIdx < restIdx, `authentication (${authIdx}) should come before rest (${restIdx})`);
	});

	it('`before` applies to the FIRST registered entry with that name', () => {
		const a1 = entry('a');
		const a2 = entry('a');
		const b = entry('b', { before: 'a' }); // constrains against a1 only (first 'a')
		const sorted = topoSort([a1, a2, b]);
		// b must come before a1 (the constrained entry); a2 has no constraint with b
		assert.ok(sorted.indexOf(b) < sorted.indexOf(a1), 'b should come before first registered a');
	});

	it('`after` applies to the LAST registered entry with that name', () => {
		const a1 = entry('a');
		const a2 = entry('a');
		const b = entry('b', { after: 'a' }); // constrains against a2 only (last 'a')
		const sorted = topoSort([a1, a2, b]);
		assert.ok(sorted.indexOf(a2) < sorted.indexOf(b), 'b should come after last registered a');
		assert.ok(sorted.indexOf(a1) < sorted.indexOf(b), 'b should also come after a1 (a1 precedes a2)');
	});

	it('reference to unknown name is a no-op', () => {
		const a = entry('a', { after: 'nonexistent' });
		const b = entry('b');
		const sorted = topoSort([a, b]);
		assert.deepStrictEqual(
			sorted.map((e) => e.name),
			['a', 'b']
		);
	});

	it('calls onCycle and returns original order when cycle detected', () => {
		let cycleCalled = false;
		const a = entry('a', { after: 'b' });
		const b = entry('b', { after: 'a' });
		const original = [a, b];
		const result = topoSort(original, () => {
			cycleCalled = true;
		});
		assert.strictEqual(cycleCalled, true, 'onCycle should be called');
		assert.strictEqual(result, original, 'should return original array on cycle');
	});
});

// --------------------------------------------------------------------------
// buildLinearChain
// --------------------------------------------------------------------------

describe('buildLinearChain', () => {
	it('returns fallback when entry list is empty', () => {
		const chain = buildLinearChain([], UNHANDLED);
		assert.deepStrictEqual(chain(req()), { status: -1 });
	});

	it('calls the single listener with (request, next)', () => {
		let calledWith;
		const e = entry('a', {
			listener: (r, next) => {
				calledWith = r;
				return next(r);
			},
		});
		const chain = buildLinearChain([e], UNHANDLED);
		const r = req();
		chain(r);
		assert.strictEqual(calledWith, r);
	});

	it('calls listeners in sorted order and threads next correctly', () => {
		const order = [];
		const entries = ['a', 'b', 'c'].map((n) =>
			entry(n, {
				listener: (r, next) => {
					order.push(n);
					return next(r);
				},
			})
		);
		const chain = buildLinearChain(entries, UNHANDLED);
		chain(req());
		assert.deepStrictEqual(order, ['a', 'b', 'c']);
	});

	it('short-circuits when a listener returns without calling next', () => {
		const order = [];
		const a = entry('a', {
			listener: (_r, _next) => {
				order.push('a');
				return { status: 200 };
			},
		});
		const b = entry('b', {
			listener: (r, next) => {
				order.push('b');
				return next(r);
			},
		});
		const chain = buildLinearChain([a, b], UNHANDLED);
		const result = chain(req());
		assert.deepStrictEqual(order, ['a']);
		assert.deepStrictEqual(result, { status: 200 });
	});
});

// --------------------------------------------------------------------------
// resolveDeps
// --------------------------------------------------------------------------

describe('resolveDeps', () => {
	it('returns same entries when no after deps', () => {
		const entries = ['a', 'b'].map((n) => entry(n));
		const registry = new Map(entries.map((e) => [e.name, e]));
		const result = resolveDeps(entries, registry);
		assert.deepStrictEqual(new Set(result), new Set(entries));
	});

	it('pulls in a dep that is in the registry but not the entry list', () => {
		const auth = entry('authentication');
		const rest = entry('rest', { after: 'authentication' });
		const registry = new Map([
			['authentication', auth],
			['rest', rest],
		]);
		// Only rest is in the initial list; auth should be pulled in
		const result = resolveDeps([rest], registry);
		assert.ok(result.includes(auth), 'auth should be pulled in');
		assert.ok(result.includes(rest), 'rest should remain');
	});

	it('resolves transitive deps: A after B, B after C', () => {
		const c = entry('c');
		const b = entry('b', { after: 'c' });
		const a = entry('a', { after: 'b' });
		const registry = new Map([
			['a', a],
			['b', b],
			['c', c],
		]);
		const result = resolveDeps([a], registry);
		assert.ok(result.includes(b), 'b should be pulled in');
		assert.ok(result.includes(c), 'c should be pulled in transitively');
	});

	it('does NOT pull in entries referenced only by `before`', () => {
		const auth = entry('authentication');
		const staticE = entry('static', { before: 'authentication' });
		const registry = new Map([
			['authentication', auth],
			['static', staticE],
		]);
		// static declares before:auth but auth is not in the list
		const result = resolveDeps([staticE], registry);
		assert.ok(!result.includes(auth), 'auth should NOT be pulled in via before');
	});

	it('ignores unknown dep names', () => {
		const a = entry('a', { after: 'nonexistent' });
		const registry = new Map([['a', a]]);
		const result = resolveDeps([a], registry);
		assert.deepStrictEqual(result, [a]);
	});
});

// --------------------------------------------------------------------------
// matchesRoute
// --------------------------------------------------------------------------

describe('matchesRoute', () => {
	it('matches everything when no constraints', () => {
		assert.strictEqual(matchesRoute(req('/foo'), {}), true);
	});

	it('matches exact urlPath', () => {
		assert.strictEqual(matchesRoute(req('/api'), { urlPath: '/api' }), true);
	});

	it('matches urlPath with sub-path', () => {
		assert.strictEqual(matchesRoute(req('/api/products'), { urlPath: '/api' }), true);
	});

	it('does NOT match a path that is merely a string-prefix (segment boundary required)', () => {
		assert.strictEqual(matchesRoute(req('/api2'), { urlPath: '/api' }), false);
	});

	it('does NOT match a completely different path', () => {
		assert.strictEqual(matchesRoute(req('/other'), { urlPath: '/api' }), false);
	});

	it('matches virtual host (ignoring port in Host header)', () => {
		assert.strictEqual(matchesRoute(req('/', 'example.com:8080'), { host: 'example.com' }), true);
	});

	it('does NOT match wrong host', () => {
		assert.strictEqual(matchesRoute(req('/', 'other.com'), { host: 'example.com' }), false);
	});

	it('requires both host and urlPath to match', () => {
		const route = { host: 'example.com', urlPath: '/api' };
		assert.strictEqual(matchesRoute(req('/api', 'example.com'), route), true);
		assert.strictEqual(matchesRoute(req('/api', 'other.com'), route), false);
		assert.strictEqual(matchesRoute(req('/other', 'example.com'), route), false);
	});
});

// --------------------------------------------------------------------------
// makeCallbackChain — integration
// --------------------------------------------------------------------------

describe('makeCallbackChain', () => {
	it('flat chain: no sub-routes, calls middleware in registration order', () => {
		const order = [];
		const responders = ['a', 'b', 'c'].map((n) => ({
			name: n,
			port: 9000,
			listener: (r, next) => {
				order.push(n);
				return next(r);
			},
		}));
		const chain = makeCallbackChain(responders, 9000, UNHANDLED);
		chain(req());
		assert.deepStrictEqual(order, ['a', 'b', 'c']);
	});

	it('flat chain: before/after constraints override registration order', () => {
		const order = [];
		const responders = [
			{
				name: 'rest',
				port: 9000,
				after: 'authentication',
				listener: (r, next) => {
					order.push('rest');
					return next(r);
				},
			},
			{
				name: 'authentication',
				port: 9000,
				listener: (r, next) => {
					order.push('authentication');
					return next(r);
				},
			},
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED);
		chain(req());
		assert.deepStrictEqual(order, ['authentication', 'rest']);
	});

	it('filters by port: only includes matching port entries', () => {
		const order = [];
		const responders = [
			{
				name: 'a',
				port: 9000,
				listener: (r, next) => {
					order.push('a');
					return next(r);
				},
			},
			{
				name: 'b',
				port: 8080,
				listener: (r, next) => {
					order.push('b');
					return next(r);
				},
			},
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED);
		chain(req());
		assert.deepStrictEqual(order, ['a']);
	});

	it('port "all" entries appear in every port chain', () => {
		const order = [];
		const responders = [
			{
				name: 'cors',
				port: 'all',
				listener: (r, next) => {
					order.push('cors');
					return next(r);
				},
			},
			{
				name: 'a',
				port: 9000,
				listener: (r, next) => {
					order.push('a');
					return next(r);
				},
			},
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED);
		chain(req());
		assert.ok(order.includes('cors'), 'cors (port:all) should be included');
		assert.ok(order.includes('a'));
	});

	it('routes to sub-chain by urlPath', () => {
		const order = [];
		const responders = [
			{
				name: 'api-handler',
				port: 9000,
				urlPath: '/api',
				listener: (r, next) => {
					order.push('api');
					return next(r);
				},
			},
			{
				name: 'default-handler',
				port: 9000,
				listener: (r, next) => {
					order.push('default');
					return next(r);
				},
			},
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED);

		order.length = 0;
		chain(req('/api/products'));
		assert.deepStrictEqual(order, ['api']);

		order.length = 0;
		chain(req('/other'));
		assert.deepStrictEqual(order, ['default']);
	});

	it('routes to sub-chain by host', () => {
		const order = [];
		const responders = [
			{
				name: 'vhost-handler',
				port: 9000,
				host: 'example.com',
				listener: (r, next) => {
					order.push('vhost');
					return next(r);
				},
			},
			{
				name: 'default-handler',
				port: 9000,
				listener: (r, next) => {
					order.push('default');
					return next(r);
				},
			},
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED);

		order.length = 0;
		chain(req('/', 'example.com'));
		assert.deepStrictEqual(order, ['vhost']);

		order.length = 0;
		chain(req('/', 'other.com'));
		assert.deepStrictEqual(order, ['default']);
	});

	it('sub-route auto-pulls auth via `after` dependency', () => {
		const order = [];
		const responders = [
			// auth on default route
			{
				name: 'authentication',
				port: 9000,
				listener: (r, next) => {
					order.push('authentication');
					return next(r);
				},
			},
			// rest on /api, declares it needs to run after auth
			{
				name: 'rest',
				port: 9000,
				urlPath: '/api',
				after: 'authentication',
				listener: (r, next) => {
					order.push('rest');
					return next(r);
				},
			},
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED);

		chain(req('/api/products'));
		assert.ok(order.includes('authentication'), 'auth should run for /api requests');
		assert.ok(order.indexOf('authentication') < order.indexOf('rest'), 'auth should run before rest');
	});

	it('sub-route with `after` dep: dep runs once, not twice', () => {
		let authCount = 0;
		const responders = [
			{
				name: 'authentication',
				port: 9000,
				listener: (r, next) => {
					authCount++;
					return next(r);
				},
			},
			{ name: 'rest', port: 9000, urlPath: '/api', after: 'authentication', listener: (r, next) => next(r) },
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED);
		chain(req('/api/products'));
		assert.strictEqual(authCount, 1, 'auth should run exactly once per request');
	});

	it('specificity: host+path wins over path-only for same urlPath prefix', () => {
		const order = [];
		const responders = [
			{
				name: 'path-only',
				port: 9000,
				urlPath: '/api',
				listener: (r, next) => {
					order.push('path-only');
					return next(r);
				},
			},
			{
				name: 'host-path',
				port: 9000,
				host: 'example.com',
				urlPath: '/api',
				listener: (r, next) => {
					order.push('host-path');
					return next(r);
				},
			},
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED);
		chain(req('/api', 'example.com'));
		assert.deepStrictEqual(order, ['host-path']);
	});

	it('longer urlPath wins over shorter prefix', () => {
		const order = [];
		const responders = [
			{
				name: 'short',
				port: 9000,
				urlPath: '/api',
				listener: (r, next) => {
					order.push('short');
					return next(r);
				},
			},
			{
				name: 'long',
				port: 9000,
				urlPath: '/api/v2',
				listener: (r, next) => {
					order.push('long');
					return next(r);
				},
			},
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED);
		chain(req('/api/v2/products'));
		assert.deepStrictEqual(order, ['long']);
	});
});

// ---------------------------------------------------------------------------
// stripPrefix
// ---------------------------------------------------------------------------

describe('stripPrefix', () => {
	it('strips the prefix from pathname', () => {
		const r = stripPrefix(req('/api/products'), '/api');
		assert.strictEqual(r.pathname, '/products');
	});

	it('strips the prefix from url', () => {
		const r = stripPrefix(req('/api/products', undefined, '/api/products?q=1'), '/api');
		assert.strictEqual(r.url, '/products?q=1');
	});

	it('returns "/" when pathname equals prefix exactly', () => {
		const r = stripPrefix(req('/api'), '/api');
		assert.strictEqual(r.pathname, '/');
	});

	it('does not mutate the original request', () => {
		const original = req('/api/products');
		stripPrefix(original, '/api');
		assert.strictEqual(original.pathname, '/api/products');
	});

	it('sub-route chain receives stripped pathname', () => {
		const seen = [];
		const responders = [
			{
				name: 'api-handler',
				port: 9000,
				urlPath: '/api',
				listener: (r, next) => {
					seen.push(r.pathname);
					return next(r);
				},
			},
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED);
		chain(req('/api/products'));
		assert.deepStrictEqual(seen, ['/products']);
	});

	it('sub-route chain receives "/" for exact prefix match', () => {
		const seen = [];
		const responders = [
			{
				name: 'api-handler',
				port: 9000,
				urlPath: '/api',
				listener: (r, next) => {
					seen.push(r.pathname);
					return next(r);
				},
			},
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED);
		chain(req('/api'));
		assert.deepStrictEqual(seen, ['/']);
	});

	it('default chain receives unmodified pathname', () => {
		const seen = [];
		const responders = [
			{ name: 'api-handler', port: 9000, urlPath: '/api', listener: (r, next) => next(r) },
			{
				name: 'default-handler',
				port: 9000,
				listener: (r, next) => {
					seen.push(r.pathname);
					return next(r);
				},
			},
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED);
		chain(req('/other/path'));
		assert.deepStrictEqual(seen, ['/other/path']);
	});

	it('treats trailing slash on prefix as equivalent (no malformed paths)', () => {
		const r = stripPrefix(req('/api/foo'), '/api/');
		assert.strictEqual(r.pathname, '/foo');
		const r2 = stripPrefix(req('/api/foo', undefined, '/api/foo?x=1'), '/api/');
		assert.strictEqual(r2.url, '/foo?x=1');
	});

	it('reflects downstream pathname mutations (lazy evaluation)', () => {
		const original = req('/api/products');
		const proxied = stripPrefix(original, '/api');
		assert.strictEqual(proxied.pathname, '/products');
		original.pathname = '/api/things';
		assert.strictEqual(proxied.pathname, '/things');
	});
});

// ---------------------------------------------------------------------------
// normalizeUrlPath
// ---------------------------------------------------------------------------

describe('normalizeUrlPath', () => {
	it('returns undefined for undefined/empty', () => {
		assert.strictEqual(normalizeUrlPath(undefined), undefined);
		assert.strictEqual(normalizeUrlPath(''), '');
	});

	it('preserves root "/"', () => {
		assert.strictEqual(normalizeUrlPath('/'), '/');
	});

	it('strips a single trailing slash', () => {
		assert.strictEqual(normalizeUrlPath('/api/'), '/api');
	});

	it('leaves paths without trailing slash unchanged', () => {
		assert.strictEqual(normalizeUrlPath('/api/v2'), '/api/v2');
	});

	it('adds a leading slash to slash-less paths (#1583)', () => {
		assert.strictEqual(normalizeUrlPath('assets'), '/assets');
		assert.strictEqual(normalizeUrlPath('assets/'), '/assets');
		assert.strictEqual(normalizeUrlPath('a'), '/a');
	});
});

// ---------------------------------------------------------------------------
// matchesRoute with slash-less urlPath (#1583)
// ---------------------------------------------------------------------------

describe('matchesRoute with slash-less urlPath', () => {
	it('matches as if the leading slash were present', () => {
		assert.strictEqual(matchesRoute(req('/assets/test.css'), { urlPath: 'assets' }), true);
		assert.strictEqual(matchesRoute(req('/assets'), { urlPath: 'assets' }), true);
		assert.strictEqual(matchesRoute(req('/assets2/x'), { urlPath: 'assets' }), false);
	});
});

// ---------------------------------------------------------------------------
// stripPrefix originalPathname passthrough (#1583)
// ---------------------------------------------------------------------------

describe('stripPrefix originalPathname', () => {
	it('exposes the unstripped pathname so handlers can distinguish /mount from /mount/', () => {
		const noSlash = stripPrefix(req('/assets'), '/assets');
		assert.strictEqual(noSlash.pathname, '/');
		assert.strictEqual(noSlash.originalPathname, '/assets');
		const withSlash = stripPrefix(req('/assets/'), '/assets');
		assert.strictEqual(withSlash.pathname, '/');
		assert.strictEqual(withSlash.originalPathname, '/assets/');
	});
});

// ---------------------------------------------------------------------------
// matchesRoute trailing-slash tolerance
// ---------------------------------------------------------------------------

describe('matchesRoute with trailing slash', () => {
	it('matches sub-paths when route.urlPath ends with "/"', () => {
		assert.strictEqual(matchesRoute(req('/api/foo'), { urlPath: '/api/' }), true);
		assert.strictEqual(matchesRoute(req('/api'), { urlPath: '/api/' }), true);
		assert.strictEqual(matchesRoute(req('/api2'), { urlPath: '/api/' }), false);
	});
});

// ---------------------------------------------------------------------------
// variadic dispatch (request at non-zero arg index, e.g. WebSocket chains)
// ---------------------------------------------------------------------------

describe('variadic dispatch with requestArgIndex', () => {
	it('forwards all positional args to the inner chain (default chain)', () => {
		const seen = [];
		const responders = [
			entry('ws-handler', {
				listener: (ws, req, completion, next) => {
					seen.push({ ws, pathname: req.pathname, completion });
					return next(ws, req, completion);
				},
			}),
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED, undefined, 1);
		const fakeWs = { sym: 'ws' };
		const fakeCompletion = Promise.resolve();
		chain(fakeWs, req('/anything'), fakeCompletion);
		assert.strictEqual(seen.length, 1);
		assert.strictEqual(seen[0].ws, fakeWs);
		assert.strictEqual(seen[0].pathname, '/anything');
		assert.strictEqual(seen[0].completion, fakeCompletion);
	});

	it('routes by urlPath using arg at requestArgIndex, preserves other args (sub-route)', () => {
		const seen = [];
		const responders = [
			{
				name: 'api-ws',
				port: 9000,
				urlPath: '/api',
				listener: (ws, req, completion, next) => {
					seen.push({ ws, pathname: req.pathname, completion });
					return next(ws, req, completion);
				},
			},
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED, undefined, 1);
		const fakeWs = { sym: 'ws' };
		const fakeCompletion = Promise.resolve();
		chain(fakeWs, req('/api/products'), fakeCompletion);
		assert.strictEqual(seen.length, 1);
		assert.strictEqual(seen[0].ws, fakeWs, 'ws should be forwarded at arg 0');
		assert.strictEqual(seen[0].pathname, '/products', 'request at arg 1 should be prefix-stripped');
		assert.strictEqual(seen[0].completion, fakeCompletion, 'completion should be forwarded at arg 2');
	});

	it('upgrade-style signature: forwards (request, socket, head) when routing', () => {
		const seen = [];
		const responders = [
			{
				name: 'upgrade-handler',
				port: 9000,
				urlPath: '/api',
				listener: (req, socket, head, next) => {
					seen.push({ pathname: req.pathname, socket, head });
					return next(req, socket, head);
				},
			},
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED, undefined, 0);
		const fakeSocket = { sym: 'socket' };
		const fakeHead = Buffer.from([]);
		chain(req('/api/upgrade'), fakeSocket, fakeHead);
		assert.strictEqual(seen.length, 1);
		assert.strictEqual(seen[0].pathname, '/upgrade');
		assert.strictEqual(seen[0].socket, fakeSocket);
		assert.strictEqual(seen[0].head, fakeHead);
	});
});

// ---------------------------------------------------------------------------
// onCycle callback
// ---------------------------------------------------------------------------

describe('onCycle callback', () => {
	it('invokes onCycle and falls back to registration order when cycles exist', () => {
		const a = entry('a', { before: 'b' });
		const b = entry('b', { before: 'a' });
		let called = 0;
		const sorted = topoSort([a, b], () => called++);
		assert.strictEqual(called, 1);
		assert.deepStrictEqual(sorted, [a, b]);
	});

	it('is wired through makeCallbackChain', () => {
		const responders = [
			entry('a', { before: 'b', listener: (r, next) => next(r) }),
			entry('b', { before: 'a', listener: (r, next) => next(r) }),
		];
		let called = 0;
		makeCallbackChain(responders, 9000, UNHANDLED, () => called++);
		assert.strictEqual(called, 1);
	});
});

// ---------------------------------------------------------------------------
// describeChains (#1573)
// ---------------------------------------------------------------------------

describe('describeChains', () => {
	/** Records the order listeners are invoked in when the built chain runs `request`. */
	function tracedResponders(names, extra = {}) {
		const trace = [];
		const responders = names.map((name) => {
			const opts = Object.assign({}, extra[name]);
			opts.listener = (request, next) => {
				trace.push(name);
				return next(request);
			};
			return entry(name, opts);
		});
		return { responders, trace };
	}

	it('returns a single default route reflecting topo-sorted order (flat case)', () => {
		const responders = [entry('a'), entry('b', { before: 'a' }), entry('c')];
		const described = describeChains(responders, 9000);
		assert.strictEqual(described.length, 1);
		assert.strictEqual(described[0].host, undefined);
		assert.strictEqual(described[0].urlPath, undefined);
		assert.deepStrictEqual(
			described[0].order.map((e) => e.name),
			['b', 'a', 'c']
		);
	});

	it('filters to entries on the requested port (plus `all`)', () => {
		const responders = [entry('a', { port: 9000 }), entry('b', { port: 9001 }), entry('c', { port: 'all' })];
		const described = describeChains(responders, 9000);
		assert.deepStrictEqual(
			described[0].order.map((e) => e.name),
			['a', 'c']
		);
	});

	it('describes sub-routes in dispatch priority order, default last', () => {
		const responders = [
			entry('root'),
			entry('api', { urlPath: '/api' }),
			entry('apiv2', { urlPath: '/api/v2' }),
			entry('vhost', { host: 'admin.example.com' }),
		];
		const described = describeChains(responders, 9000);
		// host+path/host > longer path > shorter path > default
		const scopes = described.map((r) => r.host ?? r.urlPath ?? '(default)');
		assert.deepStrictEqual(scopes, ['admin.example.com', '/api/v2', '/api', '(default)']);
		assert.strictEqual(described[described.length - 1].urlPath, undefined);
		assert.strictEqual(described[described.length - 1].host, undefined);
	});

	it('matches the order the built chain actually executes', () => {
		const { responders, trace } = tracedResponders(['a', 'b', 'c'], {
			c: { before: 'a' }, // c must run first
		});
		const described = describeChains(responders, 9000);
		const chain = makeCallbackChain(responders, 9000, UNHANDLED);
		chain(req('/'));
		assert.deepStrictEqual(
			described[0].order.map((e) => e.name),
			trace,
			'described order should equal executed order'
		);
		// c declares before:'a'; registration order a,b,c → b (unconstrained, index 1), then c, then a.
		assert.deepStrictEqual(trace, ['b', 'c', 'a']);
	});

	it('folds `all` responders into a concrete port and matches makeCallbackChain selection', () => {
		const responders = [
			entry('rest', { port: 9000 }),
			entry('auth', { port: 'all', before: 'rest' }),
			entry('other', { port: 9001 }),
		];
		// Global 'all' middleware applies to the concrete port; entries on other ports do not. The
		// described order must equal what the built chain serves for the same port.
		const described = describeChains(responders, 9000);
		const trace = [];
		const traced = responders.map((r) => ({
			...r,
			listener: (request, next) => {
				trace.push(r.name);
				return next(request);
			},
		}));
		makeCallbackChain(traced, 9000, UNHANDLED)(req('/'));
		assert.deepStrictEqual(
			described[0].order.map((e) => e.name),
			['auth', 'rest']
		);
		assert.deepStrictEqual(trace, ['auth', 'rest']);
	});

	it('resolveRoutedChains pulls in `after` deps and orders sub-routes', () => {
		const responders = [entry('auth'), entry('waf', { urlPath: '/secure', after: 'auth' })];
		const resolved = resolveRoutedChains(responders);
		const secure = resolved.find((r) => r.urlPath === '/secure');
		// auth is pulled into the /secure route and ordered before waf
		assert.deepStrictEqual(
			secure.order.map((e) => e.name),
			['auth', 'waf']
		);
	});
});

// ---------------------------------------------------------------------------
// onUnresolved callback
// ---------------------------------------------------------------------------

describe('onUnresolved callback', () => {
	it('findUnresolvedOrderingRefs reports before/after names that match no entry', () => {
		const entries = [
			entry('static', { after: 'rest' }),
			entry('other', { before: 'Authentication' }),
			entry('authentication'),
		];
		assert.deepStrictEqual(findUnresolvedOrderingRefs(entries), [
			{ entryName: 'static', kind: 'after', target: 'rest' },
			{ entryName: 'other', kind: 'before', target: 'Authentication' },
		]);
	});

	it('findUnresolvedOrderingRefs is empty when all references resolve', () => {
		const entries = [entry('static', { after: 'rest' }), entry('rest')];
		assert.deepStrictEqual(findUnresolvedOrderingRefs(entries), []);
	});

	it('reports unresolved references on the first dispatch only', () => {
		const responders = [entry('static', { after: 'rest', listener: (r, next) => next(r) })];
		const reported = [];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED, undefined, 0, (ref) => reported.push(ref));
		assert.deepStrictEqual(reported, []); // build time: the chain may be rebuilt with more entries
		chain(req());
		chain(req());
		assert.deepStrictEqual(reported, [{ entryName: 'static', kind: 'after', target: 'rest' }]);
	});

	it('still dispatches the chain normally while reporting', () => {
		const order = [];
		const responders = [
			entry('static', {
				after: 'nope',
				listener: (r, next) => {
					order.push('static');
					return next(r);
				},
			}),
		];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED, undefined, 0, () => {});
		const result = chain(req());
		assert.deepStrictEqual(order, ['static']);
		assert.strictEqual(result.status, -1);
	});

	it('does not wrap the chain when everything resolves', () => {
		const responders = [
			entry('static', { after: 'rest', listener: (r, next) => next(r) }),
			entry('rest', { listener: (r, next) => next(r) }),
		];
		const reported = [];
		const chain = makeCallbackChain(responders, 9000, UNHANDLED, undefined, 0, (ref) => reported.push(ref));
		chain(req());
		assert.deepStrictEqual(reported, []);
	});
});
