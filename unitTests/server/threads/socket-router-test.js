const { startHTTPThreads, startSocketServer, updateWorkerIdleness, remoteAffinityRouting, mostIdleRouting } = require('../../../server/threads/socket-router');
const { shutdownWorkers } = require('../../../server/threads/start-threads');
const terms = require('../../../utility/hdbTerms');
const assert = require('assert');

describe('Socket Router', () => {
	let workers, server;
	before(function() {
		workers = startHTTPThreads(4);
	});
	it('Start HTTP threads and delegate evenly by most idle', function () {
		server = startSocketServer(terms.SERVICES.HDB_CORE, 0, mostIdleRouting);

		for (let worker of workers) {
			worker.socketsRouted = 0;
			worker.postMessage = function({ type, fd }) {
				// stub this and don't send to real worker, just count messages
				this.socketsRouted++;
				assert.equal(type, terms.SERVICES.HDB_CORE);
				assert.equal(fd, 1);
			};
		}
		workers[2].expectedIdle = 2; // give this one a higher expected idle
		// simulate a bunch of incoming connections
		for (let i = 0; i < 100; i++) {
			server.emit('connection', { _handle: { fd: 1 }});
		}
		// make sure that the messages are reasonably evenly distributed
		for (let worker of workers) {
			assert.ok(worker.socketsRouted > 15, 'Received enough connections');
		}
		// make sure worker[2] got more because it had a higher expected idle
		assert.ok(workers[2].socketsRouted > 30, 'Received enough connections');

		updateWorkerIdleness(); // should reset idleness

		for (let i = 0; i < 100; i++) {
			server.emit('connection', { _handle: { fd: 1 }});
		}
		// make sure that the messages are still reasonably evenly distributed
		for (let worker of workers) {
			assert.ok(worker.socketsRouted > 40, 'Received enough connections');
		}
	});

	it('Start HTTP threads and delegate by remote address', function () {
		server = startSocketServer(terms.SERVICES.HDB_CORE, 0, remoteAffinityRouting);

		for (let worker of workers) {
			worker.socketsRouted = 0;
			worker.postMessage = function({ type, fd }) {
				// stub this and don't send to real worker, just count messages
				this.socketsRouted++;
				assert.equal(type, terms.SERVICES.HDB_CORE);
				assert.equal(fd, 1);
			};
		}
		for (let i = 0; i < 100; i++) {
			server.emit('connection', { _handle: { fd: 1 }, remoteAddress: (i % 4) === 0 ? '1.2.3.4' : '5.6.7.8'});
		}
		// we don't care which worker got the most, but need to make sure they got the right amount
		let sortedWorkers = workers.slice(0).sort((a, b) => a.socketsRouted > b.socketsRouted ? -1 : 1);

		assert.equal(sortedWorkers[0].socketsRouted, 75, 'Received correct connections');
		assert.equal(sortedWorkers[1].socketsRouted, 25, 'Received correct connections');
		assert.equal(sortedWorkers[2].socketsRouted, 0, 'Received correct connections');
		assert.equal(sortedWorkers[3].socketsRouted, 0, 'Received correct connections');
		updateWorkerIdleness(); // should reset idleness

		for (let i = 0; i < 100; i++) {
			server.emit('connection', { _handle: { fd: 1 }, remoteAddress: (i % 4) === 0 ? '1.2.3.4' : '5.6.7.8'});
		}
		assert.equal(sortedWorkers[0].socketsRouted, 150, 'Received correct connections');
		assert.equal(sortedWorkers[1].socketsRouted, 50, 'Received correct connections');
		assert.equal(sortedWorkers[2].socketsRouted, 0, 'Received correct connections');
		assert.equal(sortedWorkers[3].socketsRouted, 0, 'Received correct connections');
	});
	afterEach(function(done) {
		server.close(done);
	});
	after(function() {
		shutdownWorkers(terms.SERVICES.HDB_CORE);
	});
});
