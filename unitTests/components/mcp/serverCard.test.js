const assert = require('node:assert');
const { Readable } = require('node:stream');
const { createServerCardHandler, serverCardUrlPath } = require('#src/components/mcp/serverCard');
const {
	configureApplicationServerCard,
	setMcpServerCard,
	serverCardProblem,
	_resetApplicationInfoForTest,
} = require('#src/components/mcp/applicationInfo');
const { SERVER_INFO } = require('#src/components/mcp/lifecycle');
const { Headers } = require('#src/server/serverHelpers/Headers');
const { resolveBaseURLPath } = require('#src/components/resolveBaseURLPath');

const CARD = {
	name: 'fast.harper/fabric',
	title: 'Harper Fabric',
	description: 'Read your Harper Fabric organizations and clusters.',
	version: '1.2.3',
	websiteUrl: 'https://fabric.harper.fast',
	icons: [{ src: 'https://fabric.harper.fast/icon.png', mimeType: 'image/png', sizes: ['64x64'], theme: 'light' }],
};

function request(overrides = {}) {
	const headers = new Headers();
	for (const [name, value] of Object.entries(overrides.headers ?? {})) headers.set(name, value);
	return { method: 'GET', pathname: '/', protocol: 'https', host: 'fabric.harper.fast', ...overrides, headers };
}

async function notMine() {
	return 'next';
}

describe('mcp/serverCard (#4347)', () => {
	const handler = createServerCardHandler('/mcp');
	afterEach(() => _resetApplicationInfoForTest());

	it('mounts below the MCP endpoint wherever Scope resolves the mount to', () => {
		for (const mountPath of ['/mcp', '/mcp/', 'mcp', './tenant', '.', '/']) {
			assert.equal(
				resolveBaseURLPath('mcp', serverCardUrlPath(mountPath)),
				`${resolveBaseURLPath('mcp', mountPath)}server-card/`,
				mountPath
			);
		}
	});

	it('serves the configured card with the SEP-2127 media type, CORS and caching headers', async () => {
		configureApplicationServerCard(CARD);

		const response = await handler(request(), notMine);

		assert.equal(response.status, 200);
		assert.equal(response.headers['Content-Type'], 'application/mcp-server-card+json');
		assert.equal(response.headers['Access-Control-Allow-Origin'], '*');
		assert.equal(response.headers['Access-Control-Expose-Headers'], 'ETag');
		assert.equal(response.headers['Cache-Control'], 'public, max-age=3600');
		assert.equal(response.headers.Vary, 'Host, X-Forwarded-Proto');
		assert.match(response.headers.ETag, /^"[A-Za-z0-9_-]+"$/);
		assert.deepEqual(JSON.parse(response.body), {
			$schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
			...CARD,
			remotes: [
				{
					type: 'streamable-http',
					url: 'https://fabric.harper.fast/mcp',
					supportedProtocolVersions: ['2025-06-18', '2025-03-26'],
				},
			],
		});
	});

	it('uses a configured url for the remote, with no Vary, and omits remotes without a host', async () => {
		configureApplicationServerCard({ ...CARD, url: 'https://fabric.harper.fast/mcp' });
		const pinned = await handler(request({ host: 'attacker.example' }), notMine);
		assert.equal(JSON.parse(pinned.body).remotes[0].url, 'https://fabric.harper.fast/mcp');
		assert.equal(pinned.headers.Vary, undefined);
		assert.equal('url' in JSON.parse(pinned.body), false, 'url is not a card field');

		configureApplicationServerCard(CARD);
		const hostless = await handler(request({ host: undefined }), notMine);
		assert.equal('remotes' in JSON.parse(hostless.body), false);
	});

	it("defaults the version to Harper's and merges config fields over a registration", async () => {
		setMcpServerCard({ name: 'com.example/app', description: 'Registered', title: 'Registered title' });
		const registered = JSON.parse((await handler(request(), notMine)).body);
		assert.equal(registered.version, SERVER_INFO.version);
		assert.equal(registered.title, 'Registered title');

		configureApplicationServerCard({ description: 'Configured' });
		const merged = JSON.parse((await handler(request(), notMine)).body);
		assert.equal(merged.name, 'com.example/app');
		assert.equal(merged.description, 'Configured');
		assert.equal(merged.title, 'Registered title');
	});

	it('answers 404 until the merged card has a name and a description', async () => {
		assert.equal((await handler(request(), notMine)).status, 404);
		configureApplicationServerCard({ name: 'com.example/app' });
		const missing = await handler(request(), notMine);
		assert.equal(missing.status, 404);
		assert.equal(missing.headers['Access-Control-Allow-Origin'], '*');
		setMcpServerCard({ description: 'Now complete' });
		assert.equal((await handler(request(), notMine)).status, 200);
	});

	it('answers a matching If-None-Match with 304, and HEAD with no body', async () => {
		configureApplicationServerCard(CARD);
		const { headers } = await handler(request(), notMine);

		for (const ifNoneMatch of [headers.ETag, `W/${headers.ETag}`, `"other", ${headers.ETag}`, '*']) {
			const response = await handler(request({ headers: { 'if-none-match': ifNoneMatch } }), notMine);
			assert.equal(response.status, 304, ifNoneMatch);
			assert.equal(response.body, undefined);
			assert.equal(response.headers.ETag, headers.ETag);
		}
		assert.equal((await handler(request({ headers: { 'if-none-match': '"other"' } }), notMine)).status, 200);
		assert.equal((await handler(request({ headers: { 'if-none-match': 'not-a-tag' } }), notMine)).status, 400);

		const head = await handler(request({ method: 'HEAD' }), notMine);
		assert.equal(head.status, 200);
		assert.equal(head.body, undefined);
		assert.equal(head.headers.ETag, headers.ETag);
	});

	it('changes the ETag when the card changes', async () => {
		configureApplicationServerCard(CARD);
		const before = (await handler(request(), notMine)).headers.ETag;
		setMcpServerCard({ name: 'com.example/other', description: 'x' });
		configureApplicationServerCard({ ...CARD, version: '1.2.4' });
		assert.notEqual((await handler(request(), notMine)).headers.ETag, before);
	});

	it('answers a CORS preflight, refuses other methods while draining their body, and passes deeper paths on', async () => {
		configureApplicationServerCard(CARD);
		const preflight = await handler(request({ method: 'OPTIONS' }), notMine);
		assert.equal(preflight.status, 204);
		assert.equal(
			preflight.headers['Access-Control-Allow-Headers'],
			'Content-Type, If-None-Match, Authorization, MCP-Protocol-Version'
		);

		const body = new Readable({ read() {} });
		const post = await handler(request({ method: 'POST', body }), notMine);
		assert.equal(post.status, 405);
		assert.equal(post.headers.Allow, 'GET, HEAD, OPTIONS');
		for (let i = 0; i < 8; i++) body.push(Buffer.alloc(64 * 1024));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(body.readableLength, 0, 'an unread upload does not queue');

		assert.equal(await handler(request({ pathname: '/deeper' }), notMine), 'next');
		assert.equal(await handler(request({ isWebSocket: true }), notMine), 'next');
	});

	describe('validation', () => {
		it('accepts a partial card, and names the field of an invalid one without echoing it', () => {
			assert.equal(serverCardProblem({ title: 'Only a title' }), undefined);
			for (const [card, field] of [
				[{ name: 'no-namespace' }, 'name'],
				[{ name: 'a/' + 'b'.repeat(200) }, 'name'],
				[{ description: '' }, 'description'],
				[{ description: 'x'.repeat(101) }, 'description'],
				[{ title: 42 }, 'title'],
				[{ version: '^1.2.3' }, 'version'],
				[{ version: '1.x' }, 'version'],
				[{ websiteUrl: 'ftp://example.com' }, 'websiteUrl'],
				[{ url: 'http://example.com/mcp' }, 'url'],
				[{ icons: [{ src: 'javascript:alert(1)' }] }, 'icons'],
				[{ icons: [{ src: 'https://x.example/i.png', theme: 'blue' }] }, 'icons'],
				[{ icons: [{ src: 'https://x.example/i.png', sizes: ['big'] }] }, 'icons'],
				[{ icons: [{ src: 'https://x.example/i.png', extra: 1 }] }, 'icons'],
				[{ nmae: 'com.example/app' }, 'nmae'],
			]) {
				const problem = serverCardProblem(card);
				assert.ok(problem?.includes(field), `${JSON.stringify(card).slice(0, 40)}: ${problem}`);
				assert.ok(!problem.includes('alert'), 'the value is not echoed');
			}
			assert.equal(
				serverCardProblem({ url: 'http://localhost:9926/mcp', icons: [{ src: 'data:image/png;base64,AA' }] }),
				undefined
			);
		});

		it('throws on an invalid registration and keeps serving the previous card', async () => {
			setMcpServerCard(CARD);
			assert.throws(() => setMcpServerCard({ ...CARD, description: 'x'.repeat(101) }), TypeError);
			assert.throws(() => setMcpServerCard({ ...CARD, icons: [{ src: () => 'x' }] }), TypeError);
			assert.equal(JSON.parse((await handler(request(), notMine)).body).description, CARD.description);
		});

		it('serves a snapshot, so changing the registered object later changes nothing', async () => {
			const card = { ...CARD, icons: [{ ...CARD.icons[0], sizes: ['64x64'] }] };
			setMcpServerCard(card);
			card.description = 'changed after registration';
			card.icons[0].sizes.push('not a size');
			const served = JSON.parse((await handler(request(), notMine)).body);
			assert.equal(served.description, CARD.description);
			assert.deepEqual(served.icons[0].sizes, ['64x64']);
		});
	});
});

describe('mcp/serverCard mount paths and hashing (#4347)', () => {
	afterEach(() => _resetApplicationInfoForTest());

	it('advertises the endpoint the card was reached under, resolved like the mount', async () => {
		configureApplicationServerCard(CARD);
		for (const [originalPathname, endpoint] of [
			['/mcp/tenant/server-card', '/mcp/tenant'],
			['/mcp/server-card/', '/mcp'],
			['/server-card', '/'],
		]) {
			const response = await createServerCardHandler('./tenant')(request({ originalPathname }), notMine);
			assert.equal(JSON.parse(response.body).remotes[0].url, `https://fabric.harper.fast${endpoint}`, originalPathname);
		}
		for (const mountPath of ['mcp', '/mcp/', '/mcp']) {
			const response = await createServerCardHandler(mountPath)(request(), notMine);
			assert.equal(
				JSON.parse(response.body).remotes[0].url,
				'https://fabric.harper.fast/mcp',
				`fallback for ${mountPath}`
			);
		}
	});

	it('gives each requested authority its own ETag, and the same one again on a repeat', async () => {
		configureApplicationServerCard(CARD);
		const handler = createServerCardHandler('/mcp');
		const first = (await handler(request({ host: 'a.example' }), notMine)).headers.ETag;
		const second = (await handler(request({ host: 'b.example' }), notMine)).headers.ETag;
		assert.notEqual(first, second);
		assert.equal((await handler(request({ host: 'a.example' }), notMine)).headers.ETag, first);
	});

	it('refuses Object.prototype names and non-string icon sizes as card fields', () => {
		for (const key of ['constructor', 'isPrototypeOf', 'valueOf', 'hasOwnProperty', '__proto__']) {
			const card = JSON.parse(`{"${key}": "x"}`);
			const problem = serverCardProblem(card);
			assert.ok(problem?.includes('unknown key'), `${key}: ${problem}`);
		}
		assert.ok(
			serverCardProblem({ icons: [{ src: 'https://x.example/i.png', sizes: [['64x64']] }] })?.includes('icons')
		);
	});
});
