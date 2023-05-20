require('../../../utility/devops/tsBuild');
const {
	startHTTPThreads,
	startSocketServer,
	updateWorkerIdleness,
	remoteAffinityRouting,
	mostIdleRouting,
} = require('../../../server/threads/socketRouter');
const { shutdownWorkers } = require('../../../server/threads/manageThreads');
const terms = require('../../../utility/hdbTerms');
const assert = require('assert');

describe('Socket Router', () => {
	let workers, server;
	before(async function () {
		this.timeout(5000);
		workers = await startHTTPThreads(4);
	});
	it('Start HTTP threads and delegate evenly by most idle', function () {
		server = startSocketServer(8925, 0);

		for (let worker of workers) {
			worker.socketsRouted = 0;
			worker.postMessage = function ({ port, fd }) {
				// stub this and don't send to real worker, just count messages
				if (port) {
					this.socketsRouted++;
					assert.equal(port, 8925);
					assert.equal(fd, 1);
				}
			};
		}
		workers[2].expectedIdle = 2; // give this one a higher expected idle
		// simulate a bunch of incoming connections
		for (let i = 0; i < 100; i++) {
			server.emit('connection', { _handle: { fd: 1 } });
		}
		// make sure that the messages are reasonably evenly distributed
		for (let worker of workers) {
			assert.ok(worker.socketsRouted > 15, 'Received enough connections');
		}
		// make sure worker[2] got more because it had a higher expected idle
		assert.ok(workers[2].socketsRouted > 30, 'Received enough connections');
		for (let worker of workers) {
			worker.recentELU = { idle: 0 };
		}
		updateWorkerIdleness(); // should reset idleness

		for (let i = 0; i < 100; i++) {
			server.emit('connection', { _handle: { fd: 1 } });
		}
		// make sure that the messages are still reasonably evenly distributed
		for (let worker of workers) {
			assert.ok(worker.socketsRouted > 40, 'Received enough connections');
		}
	});

	it('Start HTTP threads and delegate by remote address', function () {
		server = startSocketServer(terms.SERVICES.HDB_CORE, 0, 'ip');

		for (let worker of workers) {
			worker.socketsRouted = 0;
			worker.postMessage = function ({ type, fd }) {
				if (type === 'added-port') return;
				// stub this and don't send to real worker, just count messages
				this.socketsRouted++;
				assert.equal(type, terms.SERVICES.HDB_CORE);
				assert.equal(fd, 1);
			};
		}
		for (let i = 0; i < 100; i++) {
			server.emit('connection', { _handle: { fd: 1 }, remoteAddress: i % 4 === 0 ? '1.2.3.4' : '5.6.7.8' });
		}
		// we don't care which worker got the most, but need to make sure they got the right amount
		let sortedWorkers = workers.slice(0).sort((a, b) => (a.socketsRouted > b.socketsRouted ? -1 : 1));

		assert.equal(sortedWorkers[0].socketsRouted, 75, 'Received correct connections');
		assert.equal(sortedWorkers[1].socketsRouted, 25, 'Received correct connections');
		assert.equal(sortedWorkers[2].socketsRouted, 0, 'Received correct connections');
		assert.equal(sortedWorkers[3].socketsRouted, 0, 'Received correct connections');
		for (let worker of workers) {
			worker.recentELU = { idle: 0 };
		}
		updateWorkerIdleness(); // should reset idleness

		for (let i = 0; i < 100; i++) {
			server.emit('connection', { _handle: { fd: 1 }, remoteAddress: i % 4 === 0 ? '1.2.3.4' : '5.6.7.8' });
		}
		assert.equal(sortedWorkers[0].socketsRouted, 150, 'Received correct connections');
		assert.equal(sortedWorkers[1].socketsRouted, 50, 'Received correct connections');
		assert.equal(sortedWorkers[2].socketsRouted, 0, 'Received correct connections');
		assert.equal(sortedWorkers[3].socketsRouted, 0, 'Received correct connections');
	});

	it('Start HTTP threads and delegate by authorization header', async function () {
		server = startSocketServer(terms.SERVICES.HDB_CORE, 0, 'Authorization');
		for (let worker of workers) {
			worker.recentELU = { idle: 0 };
		}
		updateWorkerIdleness();
		for (let worker of workers) {
			worker.socketsRouted = 0;
			worker.postMessage = function ({ type, fd }) {
				// stub this and don't send to real worker, just count messages
				this.socketsRouted++;
				assert.equal(type, terms.SERVICES.HDB_CORE);
				assert.equal(fd, 1);
			};
		}
		for (let i = 0; i < 100; i++) {
			let data_listener;
			server.emit('connection', {
				_handle: { fd: 1, readStop() {} },
				on(type, listener) {
					if (type === 'data') data_listener = listener;
				},
			});
			setTimeout(() => {
				data_listener(
					Buffer.from(
						`POST / HTTP/1.1\nHost: somehost\nAuthorization: Basic ${
							i % 4 === 0 ? '34afna2n23k=' : '4a4a5afaa5a5='
						}\n\n`
					)
				);
			}, 1);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
		// we don't care which worker got the most, but need to make sure they got the right amount
		let sortedWorkers = workers.slice(0).sort((a, b) => (a.socketsRouted > b.socketsRouted ? -1 : 1));

		assert.equal(sortedWorkers[0].socketsRouted, 75, 'Received correct connections');
		assert.equal(sortedWorkers[1].socketsRouted, 25, 'Received correct connections');
		assert.equal(sortedWorkers[2].socketsRouted, 0, 'Received correct connections');
		assert.equal(sortedWorkers[3].socketsRouted, 0, 'Received correct connections');
		for (let worker of workers) {
			worker.recentELU = { idle: 0 };
		}
	});

	afterEach(function (done) {
		for (let worker of workers) {
			delete worker.postMessage; // restore prototype method
		}
		server.close(done);
	});
	after(async function () {
		for (let worker of workers) {
			worker.terminate();
		}
	});
});
