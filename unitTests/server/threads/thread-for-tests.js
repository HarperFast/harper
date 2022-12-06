const { parentPort } = require('worker_threads');
const itc = require('../../../server/threads/itc');

let timer = setTimeout(() => {}, 10000); // use it keep the thread running until shutdown
let array = [];
parentPort.on('message', message => {
	if (message.type == 'oom') {
		while (true) {
			array.push(new Array(64));
		}
	} else if (message.type === 'throw-error') {
		throw new Error('Testing error from thread');
	} else if (message.type === 'broadcast1') {
		itc.sendItcEvent({
			type: 'broadcast1',
		});
	} else if (message.type === 'broadcast2') {
		itc.sendItcEvent({
			type: 'received-broadcast',
		});
	} else if (message.type === 'shutdown') {
		timer.unref();
	}
});
