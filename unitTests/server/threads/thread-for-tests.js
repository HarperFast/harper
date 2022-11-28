const itc = require('../../../server/threads/itc');

let timer = setTimeout(() => {}, 10000); // use it keep the thread running until shutdown
let array = [];
process.on('message', message => {
	if (message.type == 'oom') {
		while (true) {
			array.push(new Array(8));
		}
	} else if (message.type == 'throw-error') {
		throw new Error('Testing error from thread');
	} else if (message.type == 'shutdown') {
		timer.unref();
	}
});