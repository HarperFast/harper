// for now we are using mqtt-packet, but we may implement some of this ourselves, particularly packet generation so that
// we can implement more efficient progressive buffer allocation.
import { parser } from 'mqtt-packet';
import { getSession, DurableSubscriptionsSession } from './DurableSubscriptionsSession';
const parser4 = parser({ protocolVersion: 4});
const DEFAULT_MQTT_PORT = 1883;
export async function start({ server, port, webSocket }) {
	// here we basically normalize the different types of sockets to pass to our socket/message handler
	if (webSocket !== false)
		server.ws( (ws) => {
			let onMessage = onSocket(ws, (message) => ws.send(message));
			ws.on('message', onMessage);
		}, { port, subProtocol: 'mqtt' }); // if there is no port, we are piggy-backing off of default app http server
	if (port || webSocket !== true) // standard TCP socket
		server.socket((socket) => {
			let onMessage = onSocket(socket, (message) => socket.write(message));
			socket.on('data', onMessage);
		}, { port: port || DEFAULT_MQTT_PORT });
}

function onSocket(socket, send) {
	let session: DurableSubscriptionsSession;
	function onMessage(data) {
		let message = parser4.parse(data);
		switch(message.cmd) {
			case 'connect':
				//TODO: Is it a clean or durable session?
				// TODO: Do we want to prefix the user name to the client id (to prevent collisions when poor ids are used)
				session = getSession(message.clientId);
				session.setListener((message) => {
					// TODO: Send a publish command
					send(parser4.generate({
						cmd: 'publish',
						message
					}));
				});
				parser4.generate({ // Send a connection acknowledgment
					cmd: 'connack'
				});
				break;
			case 'subscribe':
				for (let subscription of message.subscriptions) {
					session.addSubscription(subscription);
				}
				break;
			case 'publish':
				break;
			case 'disconnect':
				session.end();
				break;
		}
	}
	return onMessage;
}

