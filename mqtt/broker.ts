import { parser } from 'mqtt-packet';
import { getSession } from '../server/Session';
const parser4 = parser({ protocolVersion: 4});
const DEFAULT_MQTT_PORT = 1883;
export async function start({ server, port, webSocket, resources }) {
	if (webSocket)
		server.ws((ws) => {
			let onMessage = onSocket(ws, (message) => ws.send(message));
			ws.on('message', onMessage);
		}, port); // if there is no port, we are piggy-backing off of default app http server
	else // standard TCP socket
		server.socket((socket) => {
			let onMessage = onSocket(socket, (message) => socket.write(message));
			socket.on('data', onMessage);
		}, port || DEFAULT_MQTT_PORT);
}

function onSocket(socket, send) {
	let session;
	function onMessage(data) {
		let message = parser4.parse(data);
		switch(message.cmd) {
			case 'connect':
				session = getSession(message.clientId);
				session.setListener((message) => {
					send(message);
				});
				break;
			case 'subscribe':
				for (let subscription of message.subscriptions) {
					session.addSubscription(subscription);
				}
				break;
		}
	}
	return onMessage;
}

