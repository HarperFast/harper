const { Worker } = require('worker_threads');
const { PACKAGE_ROOT } = require('../utility/hdbTerms');
const path = require('path');
const { createServer } = require('net');
const env = require('../utility/environment/environmentManager');
env.initSync();
const hdb_terms = require('../utility/hdbTerms');
// at some point we may want to actually read from the https connections

const workers = [];
const THREAD_COUNT = env.get(hdb_terms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES);
const SERVER_PORT = env.get(hdb_terms.HDB_SETTINGS_NAMES.SERVER_PORT_KEY);
for (let i = 0; i < THREAD_COUNT; i++) {
	console.log('starting worker')
	let worker = new Worker(path.join(PACKAGE_ROOT, 'server/harperdb/hdbServer.js'));
	worker.on('error', (error) => {
		console.error('error', error);
	});
	worker.on('exit', (code, message) => {
		if (code !== 0)
			console.error(`Worker stopped with exit code ${code}` + message);
	});
	workers.push(worker);
}
createServer({
	allowHalfOpen: true,
	pauseOnConnect: true,
}, (socket) => {
	/*socket.on('data', onData)
	socket.on('error', (error) => {
		console.info('Error occurred in socket', error)
	})*/
	workers[0].postMessage({fd: socket._handle.fd});
	console.log('sent message')
}).listen(SERVER_PORT);
console.log('listening');
/*} if (!isMainThread) {
	console.log('starting')
	const server = createServer({
		maxHeaderSize: 1000000,
	}, (req, res) => {
		res.writeHead(200, {'Content-Type': 'text/plain'});
		res.end('okay');
	}).listen(+process.env.HTTP_PORT || 0)
	console.log('listening on ', +process.env.HTTP_PORT || 0)
	// const server = createServer({}, app.callback()).listen(0) // random port
	const requestSockets = new Map()
	server.setTimeout(3600000) // set timeout at one hour
	parentPort.on('message', (message) => {
		console.log('got message')
		const { fd } = message;
		if (fd) {
			// HTTP server likes to allow half open sockets
			let socket = new net.Socket({fd, readable: true, writable: true, allowHalfOpen: true });
			// for each socket, deliver the connection to the HTTP server handler/parser
			server.emit('connection', socket);
			//socket.resume();
			console.log('emitted socket and resumed', fd, );
			// socket contents are encoded in latin1
			//const bufferToEmit = Buffer.from(message.data, 'latin1')
			// and then route the data that was read from the master from the socket, through this socket
			// socket.emit('data', bufferToEmit)
		}
	});
}*/
