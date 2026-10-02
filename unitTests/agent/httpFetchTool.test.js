'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { once } = require('node:events');
const {
	buildHttpFetchTool,
	checkHttpFetchTarget,
	compileAllowList,
	resolveHttpFetchConfig,
} = require('#src/agent/tools/httpFetchTool');
const { waitFor } = require('../waitFor');

const ctx = { sessionId: 'sess', scopes: { componentsRoot: '/tmp', logDir: '/tmp', configDir: '/tmp' } };
const POLICY_BLOCK = /metadata-host policy|link-local policy|refused by policy/;

describe('agent/httpFetchTool', () => {
	const httpFetchTool = buildHttpFetchTool(true);

	it('rejects non-http(s) URLs', async () => {
		await assert.rejects(httpFetchTool.handler({ url: 'file:///etc/passwd' }, ctx), /http\(s\) URL/);
	});

	it('blocks the AWS/GCP cloud-metadata IP', async () => {
		await assert.rejects(
			httpFetchTool.handler({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx),
			/metadata-host policy|link-local policy/
		);
	});

	it('blocks the GCP metadata hostname, with or without a trailing dot', async () => {
		for (const url of ['http://metadata.google.internal/computeMetadata/v1/', 'http://metadata.google.internal./']) {
			await assert.rejects(httpFetchTool.handler({ url }, ctx), /metadata-host policy/, url);
		}
	});

	it('blocks the AWS IPv6 metadata address in any spelling', async () => {
		for (const url of ['http://[fd00:ec2::254]/latest/', 'http://[FD00:EC2:0:0:0:0:0:254]/']) {
			await assert.rejects(httpFetchTool.handler({ url }, ctx), /metadata-host policy/, url);
		}
	});

	it('blocks the IPv4 link-local range beyond the canonical IMDS IP', async () => {
		await assert.rejects(httpFetchTool.handler({ url: 'http://169.254.42.42/probe' }, ctx), /link-local policy/);
	});

	it('blocks IPv4-mapped IPv6 and shorthand spellings of blocked IPv4 addresses', async () => {
		await assert.rejects(
			httpFetchTool.handler({ url: 'http://[::ffff:169.254.169.254]/' }, ctx),
			/metadata-host policy/
		);
		await assert.rejects(httpFetchTool.handler({ url: 'http://[::ffff:169.254.1.1]/' }, ctx), /link-local policy/);
		await assert.rejects(httpFetchTool.handler({ url: 'http://0xa9fea9fe/' }, ctx), /metadata-host policy/);
	});

	it('does not block localhost (operators self-test against their own server)', async () => {
		// Use port 1 so the request fails fast with a connection error rather than hitting any
		// real service. We only care that the URL passes the policy check.
		await assert.rejects(
			httpFetchTool.handler({ url: 'http://127.0.0.1:1/', timeoutMs: 500 }, ctx),
			(err) => !POLICY_BLOCK.test(err.message)
		);
	});

	it('rejects malformed URLs with a clear error', async () => {
		await assert.rejects(httpFetchTool.handler({ url: 'http://[invalid' }, ctx), /could not parse URL/);
	});
});

describe('agent/httpFetchTool resolveHttpFetchConfig', () => {
	it('defaults to enabled and passes booleans through', () => {
		assert.strictEqual(resolveHttpFetchConfig(undefined), true);
		assert.strictEqual(resolveHttpFetchConfig(true), true);
		assert.strictEqual(resolveHttpFetchConfig(false), false);
	});

	it('keeps a valid allow-list', () => {
		const allow = ['localhost', 'localhost:9926', '*.example.com', '[::1]:9926', 'bücher.de'];
		assert.deepStrictEqual(resolveHttpFetchConfig({ allow }), { allow });
	});

	it('resolves an empty allow-list to disabled', () => {
		assert.strictEqual(resolveHttpFetchConfig({ allow: [] }), false);
	});

	const invalid = [
		[null, /must be true, false, or \{ allow/],
		['false', /must be true, false, or \{ allow/],
		[1, /must be true, false, or \{ allow/],
		[['localhost'], /must be true, false, or \{ allow/],
		[{}, /allow must be a list of hosts/],
		[{ allow: null }, /allow must be a list of hosts/],
		[{ allow: 'localhost' }, /allow must be a list of hosts/],
		[{ allow: ['localhost'], alow: [] }, /unknown key\(s\): alow/],
		[{ allow: [1] }, /expected a string/],
		[{ allow: [''] }, /expected host, host:port/],
		[{ allow: ['http://example.com'] }, /expected host, host:port/],
		[{ allow: ['example.com/path'] }, /expected host, host:port/],
		[{ allow: ['user@example.com'] }, /expected host, host:port/],
		[{ allow: ['exa mple.com'] }, /expected host, host:port/],
		[{ allow: ['example.com:'] }, /expected host, host:port/],
		[{ allow: ['::1'] }, /expected host, host:port/],
		[{ allow: ['example.com:0'] }, /port must be 1-65535/],
		[{ allow: ['example.com:65536'] }, /port must be 1-65535/],
		[{ allow: ['[not-ipv6]'] }, /not an IPv6 address/],
		[{ allow: ['[fe80::1%eth0]'] }, /not an IPv6 address/],
		[{ allow: ['*'] }, /leading "\*\." label/],
		[{ allow: ['*.'] }, /leading "\*\." label/],
		[{ allow: ['a.*.com'] }, /leading "\*\." label/],
		[{ allow: ['*.*.com'] }, /leading "\*\." label/],
		[{ allow: ['*.10.0.0.1'] }, /cannot apply to an IP address/],
		[{ allow: ['exa<mple.com'] }, /not a valid host name/],
	];
	for (const [value, message] of invalid) {
		it(`rejects ${JSON.stringify(value)}`, () => {
			assert.throws(() => resolveHttpFetchConfig(value), message);
		});
	}
});

describe('agent/httpFetchTool checkHttpFetchTarget with an allow-list', () => {
	const allow = compileAllowList([
		'localhost',
		'api.example.com:8443',
		'*.example.org',
		'[::1]:9926',
		'Example.NET',
		'secure.example.com:443',
		'bücher.de',
		'127.0.0.2',
	]);
	const check = (url) => checkHttpFetchTarget(new URL(url), allow);

	const allowed = [
		'http://localhost/',
		'http://localhost:9926/path?q=1',
		'http://localhost./',
		'https://api.example.com:8443/v1',
		'https://a.example.org/',
		'https://a.b.example.org/',
		'http://[::1]:9926/',
		'http://example.net/',
		'https://secure.example.com/',
		'http://xn--bcher-kva.de/',
		'http://BÜCHER.de/',
		'http://2130706434/',
	];
	for (const url of allowed) {
		it(`allows ${url}`, () => check(url));
	}

	const refused = [
		'https://api.example.com/', // effective port 443, entry pins 8443
		'http://example.org/', // a wildcard does not cover the apex
		'http://evilexample.org/', // suffix without the dot boundary
		'http://example.org.evil.com/',
		'http://[::1]:9927/',
		'http://127.0.0.1/', // loopback is not implied by "localhost"
		'http://secure.example.com/', // effective port 80
	];
	for (const url of refused) {
		it(`refuses ${url}`, () => assert.throws(() => check(url), /refused by policy/));
	}

	it('matches the explicit port regardless of scheme', () => check('http://api.example.com:8443/'));

	it('keeps metadata and link-local addresses blocked even when listed', () => {
		const listed = compileAllowList(['169.254.169.254', 'metadata.google.internal', '[fd00:ec2::254]', '169.254.1.1']);
		for (const url of [
			'http://169.254.169.254/',
			'http://metadata.google.internal/',
			'http://[fd00:ec2::254]/',
			'http://169.254.1.1/',
		]) {
			assert.throws(() => checkHttpFetchTarget(new URL(url), listed), /metadata-host policy|link-local policy/, url);
		}
	});
});

describe('agent/httpFetchTool request handling', () => {
	let allowedServer;
	let secondAllowedServer;
	let deniedServer;
	let allowedBase;
	let secondAllowedBase;
	let deniedBase;
	let deniedHits;
	let allowedHits;
	let streamClosed;

	// Echoes what arrived, so redirect method/body/header handling is observable.
	function echo(req, res) {
		let body = '';
		req.setEncoding('utf8');
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					method: req.method,
					path: req.url,
					body,
					authorization: req.headers.authorization ?? null,
					cookie: req.headers.cookie ?? null,
					contentType: req.headers['content-type'] ?? null,
					custom: req.headers['x-custom'] ?? null,
				})
			);
		});
	}

	function route(req, res) {
		allowedHits++;
		const url = new URL(req.url, 'http://placeholder');
		switch (url.pathname) {
			case '/to': {
				req.resume();
				res.writeHead(Number(url.searchParams.get('status') ?? 302), { location: url.searchParams.get('url') });
				return res.end('redirecting');
			}
			case '/loop':
				res.writeHead(302, { location: '/loop' });
				return res.end();
			case '/no-location':
				res.writeHead(302);
				return res.end('no location');
			case '/bad-location':
				res.writeHead(302, { location: 'http://[bad' });
				return res.end();
			case '/streaming-redirect':
				// A redirect whose body never ends: the hop must release it when the target is refused.
				res.on('close', () => (streamClosed = true));
				res.writeHead(302, { location: `${deniedBase}/secret` });
				return res.write('partial body');
			case '/hang':
				return; // never responds; the request is ended by the tool's timeout
			default:
				return echo(req, res);
		}
	}

	async function listen(handler) {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		return { server, base: `http://127.0.0.1:${server.address().port}` };
	}

	before(async () => {
		({ server: allowedServer, base: allowedBase } = await listen(route));
		({ server: secondAllowedServer, base: secondAllowedBase } = await listen(echo));
		({ server: deniedServer, base: deniedBase } = await listen((req, res) => {
			deniedHits++;
			res.end('should never be reached');
		}));
	});

	after(() => {
		for (const server of [allowedServer, secondAllowedServer, deniedServer]) server.closeAllConnections();
		for (const server of [allowedServer, secondAllowedServer, deniedServer]) server.close();
	});

	beforeEach(() => {
		deniedHits = 0;
		allowedHits = 0;
		streamClosed = false;
	});

	const restricted = () => buildHttpFetchTool({ allow: [allowedBase.slice(7), secondAllowedBase.slice(7)] });
	const call = (tool, args) => tool.handler({ timeoutMs: 5000, ...args }, ctx);
	const json = (result) => JSON.parse(result.body);

	it('serves an allowed host', async () => {
		const result = await call(restricted(), { url: `${allowedBase}/hello` });
		assert.strictEqual(result.status, 200);
		assert.strictEqual(json(result).path, '/hello');
	});

	it('refuses a host outside the allow-list without connecting to it', async () => {
		await assert.rejects(call(restricted(), { url: `${deniedBase}/secret` }), /refused by policy/);
		assert.strictEqual(deniedHits, 0);
	});

	it('refuses a redirect to a host outside the allow-list without connecting to it', async () => {
		const target = encodeURIComponent(`${deniedBase}/secret`);
		await assert.rejects(call(restricted(), { url: `${allowedBase}/to?url=${target}` }), /refused by policy/);
		assert.strictEqual(deniedHits, 0);
	});

	it('refuses a redirect into the metadata blocklist when unrestricted', async () => {
		const target = encodeURIComponent('http://169.254.169.254/latest/meta-data/');
		await assert.rejects(call(buildHttpFetchTool(true), { url: `${allowedBase}/to?url=${target}` }), /metadata-host/);
	});

	it('follows an allowed redirect, resolving a relative Location', async () => {
		const result = await call(restricted(), {
			url: `${allowedBase}/to?status=301&url=${encodeURIComponent('/final')}`,
		});
		assert.strictEqual(result.status, 200);
		assert.strictEqual(json(result).path, '/final');
	});

	it('follows a redirect to a second allowed host', async () => {
		const target = encodeURIComponent(`${secondAllowedBase}/other`);
		const result = await call(restricted(), { url: `${allowedBase}/to?url=${target}` });
		assert.strictEqual(json(result).path, '/other');
	});

	it('rewrites the method the way fetch does', async () => {
		const post = { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } };
		for (const [status, method, expected] of [
			[301, 'POST', { method: 'GET', body: '', contentType: null }],
			[302, 'POST', { method: 'GET', body: '', contentType: null }],
			[303, 'PUT', { method: 'GET', body: '', contentType: null }],
			[307, 'POST', { method: 'POST', body: '{"a":1}', contentType: 'application/json' }],
			[308, 'PUT', { method: 'PUT', body: '{"a":1}', contentType: 'application/json' }],
			[302, 'PUT', { method: 'PUT', body: '{"a":1}', contentType: 'application/json' }],
			[302, 'post', { method: 'GET', body: '', contentType: null }],
		]) {
			const url = `${allowedBase}/to?status=${status}&url=${encodeURIComponent('/echo')}`;
			const echoed = json(await call(restricted(), { ...post, method, url }));
			assert.deepStrictEqual(
				{ method: echoed.method, body: echoed.body, contentType: echoed.contentType },
				expected,
				`${status} ${method}`
			);
		}
	});

	it('drops credentials on a cross-origin redirect and keeps them on a same-origin one', async () => {
		const headers = { 'authorization': 'Bearer token', 'cookie': 'session=1', 'x-custom': 'kept' };
		const sameOrigin = json(
			await call(restricted(), { headers, url: `${allowedBase}/to?url=${encodeURIComponent('/echo')}` })
		);
		assert.deepStrictEqual([sameOrigin.authorization, sameOrigin.cookie], ['Bearer token', 'session=1']);
		const crossOrigin = json(
			await call(restricted(), {
				headers,
				url: `${allowedBase}/to?url=${encodeURIComponent(`${secondAllowedBase}/x`)}`,
			})
		);
		assert.deepStrictEqual([crossOrigin.authorization, crossOrigin.cookie, crossOrigin.custom], [null, null, 'kept']);
	});

	it('stops after 20 redirects', async () => {
		await assert.rejects(call(restricted(), { url: `${allowedBase}/loop` }), /stopped after 20 redirects/);
		assert.strictEqual(allowedHits, 21);
	});

	it('returns a redirect status that carries no Location', async () => {
		const result = await call(restricted(), { url: `${allowedBase}/no-location` });
		assert.strictEqual(result.status, 302);
		assert.strictEqual(result.body, 'no location');
	});

	it('rejects an unparseable redirect Location', async () => {
		await assert.rejects(
			call(restricted(), { url: `${allowedBase}/bad-location` }),
			/could not parse redirect Location/
		);
	});

	it('releases a refused redirect response instead of leaving it streaming', async () => {
		await assert.rejects(call(restricted(), { url: `${allowedBase}/streaming-redirect` }), /refused by policy/);
		assert.strictEqual(deniedHits, 0);
		await waitFor(() => streamClosed, { message: 'the refused redirect response was never released' });
	});

	it('applies one timeout across every hop', async () => {
		const url = `${allowedBase}/to?url=${encodeURIComponent('/hang')}`;
		await assert.rejects(call(restricted(), { url, timeoutMs: 300 }), /timed out after 300ms/);
	});
});

describe('agent/httpFetchTool buildHttpFetchTool', () => {
	it('builds no tool when disabled or when the allow-list is empty', () => {
		assert.strictEqual(buildHttpFetchTool(false), undefined);
		assert.strictEqual(buildHttpFetchTool({ allow: [] }), undefined);
	});

	it('names the allowed hosts in the tool description', () => {
		const tool = buildHttpFetchTool({ allow: ['localhost:9926', '*.example.com'] });
		assert.strictEqual(tool.def.name, 'http_fetch');
		assert.match(tool.def.description, /localhost:9926, \*\.example\.com/);
		assert.doesNotMatch(buildHttpFetchTool(true).def.description, /Operator policy/);
	});
});
