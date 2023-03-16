// for now we are using mqtt-packet, but we may implement some of this ourselves, particularly packet generation so that
// we can implement more efficient progressive buffer allocation.
import { parser as makeParser, generate } from 'mqtt-packet';
import { getSession, DurableSubscriptionsSession } from './DurableSubscriptionsSession';
import { findAndValidateUser, getSuperUser } from '../security/user';
import { serializeMessage } from './serverHelpers/contentTypes';
const parser = makeParser({ protocolVersion: 4});
const DEFAULT_MQTT_PORT = 1883;
const AUTHORIZE_LOCAL = true;
export async function start({ server, port, webSocket }) {
	// here we basically normalize the different types of sockets to pass to our socket/message handler
	if (webSocket !== false)
		server.ws( (ws, request, chain_completion) => {
			let onMessage = onSocket(ws, (message) => ws.send(message), request, Promise.resolve(chain_completion).then(() => request?.user));
			ws.on('message', onMessage);
		}, { port, subProtocol: 'mqtt' }); // if there is no port, we are piggy-backing off of default app http server
	if (port || webSocket !== true) // standard TCP socket
		server.socket(async (socket) => {
			if (AUTHORIZE_LOCAL && socket.remoteAddress.includes('127.0.0.1')) {
				socket.user = await getSuperUser();
			}

			let onMessage = onSocket(socket, (message) => socket.write(message));
			socket.on('data', onMessage);
		}, { port: port || DEFAULT_MQTT_PORT });
}

function onSocket(socket, send, request, user) {
	let session: DurableSubscriptionsSession;
	function onMessage(data) {
		parser.parse(data);
	}
	parser.on('packet', async (packet) => {
		if (user?.then)
			user = await user;
		try {
			switch (packet.cmd) {
				case 'connect':
					//TODO: Is it a clean or durable session?
					// TODO: Do we want to prefix the user name to the client id (to prevent collisions when poor ids are used)
					session = await getSession(packet);
					session.user = user;
					session.setListener((topic, message) => {
						// TODO: Send a publish command in response to any messages received on our subscriptions
						send(generate({
							cmd: 'publish',
							topic,
							payload: serialize(message)
						}));
					});
					send(generate({ // Send a connection acknowledgment
						cmd: 'connack',
						returnCode: 0,
					}));
					break;
				case 'subscribe':
					let granted = [];
					for (let subscription of packet.subscriptions) {
						granted.push(session.addSubscription(subscription) || 0);
					}
					await session.committed;
					send(generate({ // Send a subscription acknowledgment
						cmd: 'suback',
						granted,
						messageId: packet.messageId,
					}));
					break;
				case 'publish':
					await session.publish(packet);
					send(generate({ // Send a subscription acknowledgment
						cmd: 'puback',
						messageId: packet.messageId,
					}));
					break;
				case 'disconnect':
					session.end();
					break;
			}
		} catch (error) {
			console.error(error);
			send(generate({ // Send a subscription acknowledgment
				cmd: 'disconnect',
			}));
		}
		function serialize(data) {
			return request ? serializeMessage(data, request) : JSON.stringify(data);
		}
	});
	return onMessage;
}

