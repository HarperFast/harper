'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');

const env = require('#src/utility/environment/environmentManager');
const { logger } = require('#src/utility/logging/logger');
const {
	hostnameToUrl,
	getThisNodeName,
	getThisNodeHostname,
	nodeNameToDisplayHost,
	clearThisNodeName,
	urlToNodeName,
} = require('#src/server/nodeName');

describe('getThisNodeName precedence (harper-pro#351)', () => {
	let sandbox;

	beforeEach(() => {
		sandbox = sinon.createSandbox();
		clearThisNodeName();
	});

	afterEach(() => {
		sandbox.restore();
		clearThisNodeName();
	});

	function stubEnv(values) {
		const stub = sandbox.stub(env, 'get');
		stub.callsFake((key) => values[key]);
		return stub;
	}

	it('prefers node.hostname (NODE_HOSTNAME) over replication.hostname', () => {
		stubEnv({ node_hostname: 'pinned-node', replication_hostname: 'real-node' });
		assert.strictEqual(getThisNodeName(), 'pinned-node');
	});

	it('falls back to replication.hostname when node.hostname is unset', () => {
		// This is the working chain harper-pro#351 protects: with node.hostname left unset
		// (the fix stops the upgrade boot from planting 'localhost'), the node keeps its
		// real identity from replication.hostname.
		stubEnv({ node_hostname: undefined, replication_hostname: 'real-node' });
		assert.strictEqual(getThisNodeName(), 'real-node');
	});

	it('warns (and does NOT recommend cementing the picked value) when both differ', () => {
		// logger.warn is conditionally present based on log level; install a stub either way
		// and restore the original after the test.
		const originalWarn = logger.warn;
		const warn = sandbox.stub();
		logger.warn = warn;
		try {
			stubEnv({ node_hostname: 'localhost', replication_hostname: 'real-node' });
			const name = getThisNodeName();
			assert.strictEqual(name, 'localhost');
		} finally {
			logger.warn = originalWarn;
		}
		assert.ok(warn.called, 'expected a warning when the two hostnames differ');
		const msg = warn.firstCall.args[0];
		// Must not steer the operator to cement the already-picked (wrong) value, and must
		// mention reconciling against hdb_nodes. Also guards against the stray trailing paren.
		assert.ok(/hdb_nodes/.test(msg), 'warning should mention reconciling against hdb_nodes');
		assert.ok(!/\)$/.test(msg), 'warning should not end with a stray trailing paren');
		assert.ok(/real-node/.test(msg), 'warning should surface the differing replication.hostname');
	});

	it('does not warn when only one of the two hostnames is set', () => {
		const originalWarn = logger.warn;
		const warn = sandbox.stub();
		logger.warn = warn;
		try {
			stubEnv({ node_hostname: 'pinned-node', replication_hostname: undefined });
			assert.strictEqual(getThisNodeName(), 'pinned-node');
		} finally {
			logger.warn = originalWarn;
		}
		assert.ok(!warn.called, 'should not warn when replication.hostname is unset');
	});
});

describe('nodeNameToDisplayHost (#2218 double-wrapped startup URLs)', () => {
	it('returns a bare host unchanged', () => {
		assert.strictEqual(nodeNameToDisplayHost('localhost'), 'localhost');
	});

	it('strips the scheme and port when node.hostname is a full URL', () => {
		assert.strictEqual(nodeNameToDisplayHost('http://localhost:9926'), 'localhost');
	});

	it('strips a bare host:port down to the host', () => {
		assert.strictEqual(nodeNameToDisplayHost('localhost:9926'), 'localhost');
	});

	it('preserves an already-bracketed IPv6 host', () => {
		assert.strictEqual(nodeNameToDisplayHost('https://[::1]:9926'), '[::1]');
	});

	it('brackets a bare IPv6 literal so composed URLs stay valid', () => {
		assert.strictEqual(nodeNameToDisplayHost('::1'), '[::1]');
	});

	it('returns an unparseable value unchanged rather than dropping it', () => {
		assert.strictEqual(nodeNameToDisplayHost('node with space'), 'node with space');
	});
});

describe('getThisNodeHostname reads and normalizes the configured node.hostname', () => {
	let originalNodeHostname;

	beforeEach(() => {
		originalNodeHostname = env.get('node_hostname');
		clearThisNodeName();
	});

	afterEach(() => {
		env.setProperty('node_hostname', originalNodeHostname);
		clearThisNodeName();
	});

	// Guards the wiring bin/run.ts depends on: the wrapper must normalize the resolved node name,
	// not return it raw. A URL-valued node.hostname no longer reaches here — it is rejected at the
	// config boundary and skipped during resolution — so the enduring normalization this proves is
	// bracketing a bare IPv6 identity, which keeps the composed startup URLs parseable.
	it('brackets a bare IPv6 node.hostname for display', () => {
		env.setProperty('node_hostname', '::1');
		clearThisNodeName();
		assert.strictEqual(getThisNodeHostname(), '[::1]');
	});

	it('returns a bare hostname unchanged', () => {
		env.setProperty('node_hostname', 'node1.example.com');
		clearThisNodeName();
		assert.strictEqual(getThisNodeHostname(), 'node1.example.com');
	});
});

describe('getThisNodeName resolves to a valid bare host (#2218)', () => {
	// node.hostname / replication.hostname are rejected as invalid at the config boundary (see the
	// configValidator suite). getThisNodeName itself never throws: it uses the first source that is a
	// valid bare host and skips an empty or unusable derived source, so it can never cache a corrupt
	// identity or crash a request-time caller. The '127.0.0.1' floor is always valid.
	let originalGet;

	beforeEach(() => {
		originalGet = env.get;
		clearThisNodeName();
	});

	afterEach(() => {
		env.get = originalGet;
		clearThisNodeName();
	});

	function resolve(values) {
		env.get = (key) => values[key];
		return getThisNodeName();
	}

	for (const value of ['node1.example.com', '::1', '2001:db8::1', '127.0.0.1']) {
		it(`returns a valid bare identity ${JSON.stringify(value)}`, () => {
			assert.strictEqual(resolve({ node_hostname: value }), value);
		});
	}

	it('falls back through replication.hostname to the derived sources', () => {
		assert.strictEqual(resolve({ node_hostname: undefined, replication_hostname: 'real-node' }), 'real-node');
	});

	it('never caches an empty identity — an empty replication.hostname is skipped, not used', () => {
		// The bug this guards: `??` does not skip '', so an empty fallback used to be cached as the
		// identity (then hostnameToUrl('') is undefined). It must fall through to the floor instead.
		assert.strictEqual(resolve({ node_hostname: undefined, replication_hostname: '' }), '127.0.0.1');
	});

	it('skips an unusable derived source rather than crashing startup', () => {
		// A derived source that is not a bare host (e.g. a certificate CN with spaces, modelled here by
		// a listening host with a space) must be skipped, not throw; resolution falls to the floor.
		assert.strictEqual(
			resolve({ node_hostname: undefined, operationsapi_network_secureport: 'bad host:9925' }),
			'127.0.0.1'
		);
	});

	it('does not throw on a malformed replication.url — the source is skipped', () => {
		// urlToNodeName(replication_url) parses a URL; a malformed value must yield no name and be
		// skipped, not throw before asBareHost runs (which would crash a request-time first caller).
		assert.strictEqual(resolve({ node_hostname: undefined, replication_url: 'not-a-url' }), '127.0.0.1');
	});

	for (const url of ['mailto:operator@example.com', 'data:text/plain,hi', 'file:///etc/passwd', 'urn:isbn:123']) {
		it(`skips a hostless replication.url (${url.split(':')[0]}:) instead of yielding an empty identity`, () => {
			// These schemes parse but have hostname === '', which would otherwise become the identity and
			// land an empty DNS SAN in the certificate (security/keys.ts getHost). Assert the empty name
			// directly at the source: resolving to the 127.0.0.1 floor alone would also hold if the
			// identity were '', since an empty value falls through the chain too.
			assert.strictEqual(urlToNodeName(url), undefined, 'a hostless URL must yield no name at all');
			assert.strictEqual(resolve({ node_hostname: undefined, replication_url: url }), '127.0.0.1');
		});
	}

	it('warns when it skips a malformed source, so a lost identity is not silent', () => {
		// The diagnosis trap this guards: a typo'd source silently resolving to 127.0.0.1 looks like a
		// working node until replication fails.
		const originalWarn = logger.warn;
		const warnings = [];
		logger.warn = (msg) => warnings.push(msg);
		try {
			env.get = (key) => ({ replication_url: 'ws://bad host:9933' })[key];
			assert.strictEqual(getThisNodeName(), '127.0.0.1');
		} finally {
			logger.warn = originalWarn;
		}
		assert.strictEqual(warnings.length, 1, 'expected one warning for the skipped source');
		assert.ok(/replication\.url/.test(warnings[0]), 'warning should name the source it ignored');
	});

	it('does not warn when every source is valid', () => {
		const originalWarn = logger.warn;
		const warnings = [];
		logger.warn = (msg) => warnings.push(msg);
		try {
			env.get = (key) => ({ node_hostname: 'node1.example.com' })[key];
			assert.strictEqual(getThisNodeName(), 'node1.example.com');
		} finally {
			logger.warn = originalWarn;
		}
		assert.strictEqual(warnings.length, 0, 'a valid identity must resolve silently');
	});

	it('derives an unbracketed IPv6 identity from a replication.url IPv6 host (parity with the listen source)', () => {
		// URL.hostname keeps IPv6 bracketed; the identity must be unbracketed so it matches the same
		// node's identity from other sources and is typed as an IP certificate SAN.
		assert.strictEqual(
			resolve({ node_hostname: undefined, replication_url: 'ws://[2001:db8::1]:9933' }),
			'2001:db8::1'
		);
	});

	it('extracts an unbracketed IPv6 identity from a bracketed listening address', () => {
		// The identity must be canonical/unbracketed ("::1") so net.isIP recognises it for the cert IP
		// SAN and so it matches the same node's identity derived from other sources.
		assert.strictEqual(resolve({ node_hostname: undefined, operationsapi_network_secureport: '[::1]:9925' }), '::1');
	});
});

describe('hostnameToUrl', () => {
	let sandbox;

	beforeEach(() => {
		sandbox = sinon.createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('returns undefined when hostname is undefined, even with a configured replication port', () => {
		sandbox.stub(env, 'get').withArgs('replication_port').returns('0.0.0.0:9933');
		assert.strictEqual(hostnameToUrl(undefined), undefined);
	});

	it('returns undefined when hostname is null', () => {
		sandbox.stub(env, 'get').withArgs('replication_port').returns('0.0.0.0:9933');
		assert.strictEqual(hostnameToUrl(null), undefined);
	});

	it('returns undefined when hostname is an empty string', () => {
		sandbox.stub(env, 'get').withArgs('replication_port').returns('0.0.0.0:9933');
		assert.strictEqual(hostnameToUrl(''), undefined);
	});

	it('still builds a ws:// url for a valid hostname when replication_port is configured', () => {
		sandbox.stub(env, 'get').withArgs('replication_port').returns('0.0.0.0:9933');
		assert.strictEqual(hostnameToUrl('host.example.com'), 'ws://host.example.com:9933');
	});

	it('brackets a bare IPv6 literal so the composed replication URL parses', () => {
		sandbox.stub(env, 'get').withArgs('replication_port').returns('0.0.0.0:9933');
		const url = hostnameToUrl('::1');
		assert.strictEqual(url, 'ws://[::1]:9933');
		// The real invariant: the constructed URL must be parseable (unbracketed "::1" is rejected).
		assert.strictEqual(new URL(url).hostname, '[::1]');
	});

	it('does not bracket an IPv4 literal', () => {
		sandbox.stub(env, 'get').withArgs('replication_port').returns('0.0.0.0:9933');
		assert.strictEqual(hostnameToUrl('127.0.0.1'), 'ws://127.0.0.1:9933');
	});
});
