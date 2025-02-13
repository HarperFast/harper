require('../../../bin/dev');
const { parentPort, isMainThread } = require('worker_threads');
const itc = require('../../../server/threads/itc');
const server_handlers = require('../../../server/itc/serverHandlers');

let timer = setTimeout(() => {}, 10000); // use it keep the thread running until shutdown
let array = [];
if (!isMainThread) {
	server_handlers.broadcast2 = (event) => {
		parentPort.postMessage({ type: 'received-broadcast' });
	};
	parentPort.on('message', (message) => {
		if (message.type == 'oom') {
			while (true) {
				array.push(new Array(64));
			}
		} else if (message.type === 'throw-error') {
			throw new Error('Testing error from thread');
		} else if (message.type === 'broadcast1') {
			itc.sendItcEvent({
				type: 'broadcast2',
			});
		} else if (message.type === 'shutdown') {
			timer.unref();
		}
	});
}
