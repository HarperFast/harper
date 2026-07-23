'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const rewire = require('rewire');
const EventEmitter = require('node:events');
const { SERVERS } = require('#src/server/serverRegistry');

/**
 * A too-long Unix domain socket path (e.g. the operations API's domain socket under a deeply
 * nested rootPath, such as a `.claude/worktrees/<name>` checkout) fails at listen() time with an
 * async 'error' event (EINVAL), not a synchronous throw. Before this fix, that rejected the
 * Promise.all() covering every listener started in the same batch — TCP ports included — which
 * aborted the whole startup sequence (see bin/run.ts's main(), which process.exit(1)s on any
 * rejection from startHTTPThreads()).
 */
describe('threadServer listenOnPorts — domain socket fail-soft', () => {
	let threadServer;

	beforeEach(() => {
		threadServer = rewire('#src/server/threads/threadServer');
		// SERVERS is a shared module-level singleton; make sure no other test/process state leaks in.
		for (const key of Object.keys(SERVERS)) delete SERVERS[key];
		threadServer.__set__('listening', undefined);
	});

	afterEach(() => {
		for (const key of Object.keys(SERVERS)) delete SERVERS[key];
		sinon.restore();
	});

	function makeFakeServer({ failWith } = {}) {
		const server = new EventEmitter();
		server.name = 'fake-server';
		server.listen = (_opts, cb) => {
			process.nextTick(() => {
				if (failWith) server.emit('error', failWith);
				else cb();
			});
			return server;
		};
		return server;
	}

	it('resolves (does not reject) when a domain socket listener fails, and logs the error', async () => {
		const harperLogger = threadServer.__get__('harperLogger');
		const errorSpy = sinon.stub(harperLogger, 'error');
		const einval = Object.assign(new Error('listen EINVAL: invalid argument'), { code: 'EINVAL' });
		const failingSocketPath = '/tmp/harper-1839-unit-test-domain-socket-simulated-einval';

		SERVERS[failingSocketPath] = makeFakeServer({ failWith: einval });

		const results = await threadServer.listenOnPorts();

		expect(results).to.have.lengthOf(1);
		expect(results[0]).to.include({ port: failingSocketPath, failed: true });
		expect(errorSpy.calledOnce).to.equal(true);
		expect(errorSpy.firstCall.args[0]).to.include(failingSocketPath);
	});

	it('still resolves a working TCP listener even when a sibling domain socket in the same batch fails', async () => {
		const harperLogger = threadServer.__get__('harperLogger');
		sinon.stub(harperLogger, 'error');
		sinon.stub(harperLogger, 'trace');
		const einval = Object.assign(new Error('listen EINVAL: invalid argument'), { code: 'EINVAL' });
		const failingSocketPath = '/tmp/harper-1839-unit-test-domain-socket-simulated-einval-2';

		SERVERS[failingSocketPath] = makeFakeServer({ failWith: einval });
		SERVERS['19925'] = makeFakeServer();

		const results = await threadServer.listenOnPorts();

		const ports = results.map((r) => r.port);
		expect(ports).to.include(failingSocketPath);
		expect(ports).to.include('19925');
	});
});
