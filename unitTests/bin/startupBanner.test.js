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

	it('composes well-formed ops + REST URLs when node.hostname is a full URL', () => {
		// A URL-valued node.hostname is exactly the #2218 trigger: getThisNodeName() returns the whole
		// URL, so the pre-fix banner produced `http://http://localhost:9926:9925/`.
		const restPort = 9926;
		const portResolutions = new Map([[restPort, [{ name: 'rest', protocol_name: 'HTTP' }]]]);

		const banner = bannerFor('http://localhost:9926', portResolutions);

		assert.ok(!banner.includes('http://http://'), `banner double-wrapped a scheme:\n${banner}`);
		assert.ok(
			banner.includes(`http://localhost:${opsPort()}/`),
			`expected the Operations-API URL http://localhost:${opsPort()}/ in banner:\n${banner}`
		);
		assert.ok(
			banner.includes(`http://localhost:${restPort}/`),
			`expected the REST URL http://localhost:${restPort}/ in banner:\n${banner}`
		);
	});

	it('composes well-formed HTTPS ops + REST URLs when node.hostname is a full URL', () => {
		const securePort = 9935;
		const restPort = 9927;
		env.setProperty(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT, securePort);
		const portResolutions = new Map([[restPort, [{ name: 'rest', protocol_name: 'HTTPS' }]]]);

		const banner = bannerFor('https://localhost:9926', portResolutions);

		assert.ok(!banner.includes('https://https://'), `banner double-wrapped a scheme:\n${banner}`);
		assert.ok(
			banner.includes(`https://localhost:${securePort}/`),
			`expected the Operations-API URL https://localhost:${securePort}/ in banner:\n${banner}`
		);
		assert.ok(
			banner.includes(`https://localhost:${restPort}/`),
			`expected the REST URL https://localhost:${restPort}/ in banner:\n${banner}`
		);
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
