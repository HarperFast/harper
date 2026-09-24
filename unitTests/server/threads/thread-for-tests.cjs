const { parentPort, isMainThread } = require('worker_threads');
// Use lower-level manageThreads for broadcasting to avoid loading the full server infrastructure
// (which includes analytics/profile.ts and @datadog/pprof that doesn't work in all environments)
const { broadcast, onMessageFromWorkers } = require('#js/server/threads/manageThreads');

let timer = setTimeout(() => {}, 10000); // use it keep the thread running until shutdown
let array = [];
if (!isMainThread) {
	// Set up a listener for broadcast2 messages from other threads
	onMessageFromWorkers((message) => {
		if (message.type === 'broadcast2') {
			parentPort.postMessage({ type: 'received-broadcast' });
		}
	});

	parentPort.on('message', (message) => {
		if (message.type == 'oom') {
			while (true) {
				array.push(new Array(64));
			}
		} else if (message.type === 'throw-error') {
			throw new Error('Testing error from thread');
		} else if (message.type === 'broadcast1') {
			// Send a broadcast2 message to all connected threads
			broadcast({
				type: 'broadcast2',
			});
		} else if (message.type === 'shutdown') {
			timer.unref();
		}
	});
}
