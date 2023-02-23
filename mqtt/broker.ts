import { createServer } from 'net';
import { registerServer } from '../server/threads/thread-http-server';
export async function start({ port, tables }) {
	const { default: Aedes } = await import('aedes');
	let broker = new Aedes({ mq: new HDBEmitter(tables)});
	let handle = broker.handle;
	const server = createServer(handle);
	port = port || 1883;
	registerServer(server, port);/*
	server.listen(port, function () {
		console.log('server started and listening on port ', port)
	});*/
}

class HDBEmitter {
	tables: any
	constructor(tables) {
		this.tables = tables;
	}
	on(topic, listener) {
		let topic_parts = topic.split('/');
		let table = this.tables[topic_parts[0]];
		if (table) {
			table.subscribe(topic_parts[1], listener);
		}
		//console.log('on', topic);
	}
	emit(event, binary) {
		//console.log('emit', event);
	}
}