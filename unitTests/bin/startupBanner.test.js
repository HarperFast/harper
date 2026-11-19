'use strict';

// End-to-end guard for the #2218 fix (double-wrapped startup URLs). The pure helper
// nodeNameToDisplayHost() is unit-tested in unitTests/server/nodeName.test.js, but nothing exercised
// startupLog() itself, so a call site that switched back from getThisNodeHostname() to
// getThisNodeName() would recreate the `http://http://host:port/` banner while that suite stayed
// green. This drives the real, exported startupLog() with a real (URL-valued) node.hostname and
// asserts the Operations-API HTTP/HTTPS and REST URL lines it prints are well-formed.

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('assert');

const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { clearThisNodeName } = require('#src/server/nodeName');
const { startupLog } = require('#src/bin/run');

describe('startupLog banner URLs (#2218 double-wrapped startup URLs)', () => {
	const originalConsoleLog = console.log;
	// initTestEnvironment() sets operationsApi_network_port=9925 and http_port=9926; the secure
	// operations port is unset by default, so tests that need it set (and restore) it explicitly. Read
	// the live ops port at assert time rather than caching it, so the expected URL always tracks the
	// same config value startupLog() reads (no load-time-vs-run-time skew if another suite mutates it).
	const opsPort = () => env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT);

	let originalNodeHostname;
	let originalSecurePort;

	beforeEach(() => {
		originalNodeHostname = env.get(CONFIG_PARAMS.NODE_HOSTNAME);
		originalSecurePort = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT);
	});

	afterEach(() => {
		console.log = originalConsoleLog;
		// Restore (not blank) the config this suite mutated so it can't leak into other suites in
		// the same mocha process.
		env.setProperty(CONFIG_PARAMS.NODE_HOSTNAME, originalNodeHostname);
		env.setProperty(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT, originalSecurePort);
		clearThisNodeName();
	});

	// Runs startupLog() with node.hostname set to `hostname`, captures the emitted banner, and
	// returns it as a single string.
	function bannerFor(hostname, portResolutions = new Map()) {
		env.setProperty(CONFIG_PARAMS.NODE_HOSTNAME, hostname);
		clearThisNodeName(); // getThisNodeName() memoizes; drop any value cached by an earlier test

		const lines = [];
		console.log = (...args) => lines.push(args.join(' '));
		try {
			startupLog(portResolutions);
		} finally {
			console.log = originalConsoleLog;
		}
		return lines.join('\n');
	}

	it('never double-wraps a scheme, and does not show a rejected URL-valued node.hostname', () => {
		// A URL-valued node.hostname was the #2218 trigger: getThisNodeName() returned the whole URL, so
		// the pre-fix banner produced `http://http://localhost:9926:9925/`. Such a value is now rejected
		// at the config boundary and skipped during identity resolution (with a warning), so it cannot
		// reach the banner at all — the banner shows the fallback identity instead of the URL's host.
		const restPort = 9926;
		const portResolutions = new Map([[restPort, [{ name: 'rest', protocol_name: 'HTTP' }]]]);

		const banner = bannerFor('http://localhost:9926', portResolutions);

		assert.ok(!banner.includes('http://http://'), `banner double-wrapped a scheme:\n${banner}`);
		assert.ok(!banner.includes('http://localhost:9926:'), `banner composed from the raw URL:\n${banner}`);
		assertBannerUrlsParse(banner);
	});

	it('composes well-formed HTTPS URLs without double-wrapping a URL-valued node.hostname', () => {
		const securePort = 9935;
		const restPort = 9927;
		env.setProperty(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT, securePort);
		const portResolutions = new Map([[restPort, [{ name: 'rest', protocol_name: 'HTTPS' }]]]);

		const banner = bannerFor('https://localhost:9926', portResolutions);

		assert.ok(!banner.includes('https://https://'), `banner double-wrapped a scheme:\n${banner}`);
		assert.ok(banner.includes(`:${securePort}/`), `expected the secure ops port in banner:\n${banner}`);
		assert.ok(banner.includes(`:${restPort}/`), `expected the REST port in banner:\n${banner}`);
		assertBannerUrlsParse(banner);
	});

	it('brackets a bare IPv6 node.hostname so the composed URLs stay parseable', () => {
		// The identity is stored unbracketed ("::1") so net.isIP types the certificate SAN as an IP;
		// the banner must bracket it, or `http://::1:9925/` is not a parseable URL.
		const restPort = 9926;
		const portResolutions = new Map([[restPort, [{ name: 'rest', protocol_name: 'HTTP' }]]]);

		const banner = bannerFor('::1', portResolutions);

		assert.ok(
			banner.includes(`http://[::1]:${opsPort()}/`),
			`expected a bracketed IPv6 Operations-API URL in banner:\n${banner}`
		);
		assertBannerUrlsParse(banner);
	});

	it('leaves a plain bare-host node.hostname unchanged in composed URLs', () => {
		// The complement of the URL case: normalization must not corrupt a hostname that was already
		// bare (over-stripping would be just as wrong as double-wrapping).
		const restPort = 9926;
		const portResolutions = new Map([[restPort, [{ name: 'rest', protocol_name: 'HTTP' }]]]);

		const banner = bannerFor('node-1.example.com', portResolutions);

		assert.ok(
			banner.includes(`http://node-1.example.com:${opsPort()}/`),
			`expected the Operations-API URL http://node-1.example.com:${opsPort()}/ in banner:\n${banner}`
		);
		assert.ok(
			banner.includes(`http://node-1.example.com:${restPort}/`),
			`expected the REST URL http://node-1.example.com:${restPort}/ in banner:\n${banner}`
		);
	});
});

// Every URL the banner prints must be parseable — the real invariant behind #2218 (a double-wrapped
// or unbracketed authority is not).
function assertBannerUrlsParse(banner) {
	for (const url of banner.match(/https?:\/\/\S+/g) ?? []) {
		assert.doesNotThrow(() => new URL(url), `banner contains an unparseable URL: ${url}`);
	}
}
