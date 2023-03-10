import {  } from 'mqtt-packet';
const DEFAULT_MQTT_PORT = 1883;
export async function start({ server, port, webSocket, resources }) {
	if (webSocket)
		server.ws((ws) => {
			let onMessage = onSocket(ws);
			ws.on('message', onMessage);
		}, port); // if there is no port, we are piggy-backing off of default app http server
	else // standard TCP socket
		server.socket((socket) => {
			let onMessage = onSocket(socket);
			socket.on('data', onMessage);
		}, port || DEFAULT_MQTT_PORT);
}

function onSocket(socket) {
	function onMessage() {

	}
	return onMessage;
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