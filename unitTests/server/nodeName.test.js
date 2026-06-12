'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');

const env = require('#src/utility/environment/environmentManager');
const { logger } = require('#src/utility/logging/logger');
const { hostnameToUrl, getThisNodeName, clearThisNodeName } = require('#src/server/nodeName');

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
});
