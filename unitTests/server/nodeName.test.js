'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');

const env = require('#src/utility/environment/environmentManager');
const { hostnameToUrl } = require('#src/server/nodeName');

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
