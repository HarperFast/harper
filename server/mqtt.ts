// for now we are using mqtt-packet, but we may implement some of this ourselves, particularly packet generation so that
// we can implement more efficient progressive buffer allocation.
import { parser as makeParser, generate } from 'mqtt-packet';
import { getSession, DurableSubscriptionsSession } from './DurableSubscriptionsSession';
import { findAndValidateUser, getSuperUser } from '../security/user';
import { serializeMessage, getDeserializer } from './serverHelpers/contentTypes';
import { threadId } from 'worker_threads';

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
			let user;
			if (AUTHORIZE_LOCAL && socket.remoteAddress.includes('127.0.0.1')) {
				user = await getSuperUser();
			}

			let onMessage = onSocket(socket, (message) => socket.write(message), null, user);
			socket.on('data', onMessage);
		}, { port: port || DEFAULT_MQTT_PORT });
}

function onSocket(socket, send, request, user) {
	let session: DurableSubscriptionsSession;
	const parser = makeParser({ protocolVersion: 4});
	function onMessage(data) {
		parser.parse(data);
	}
	parser.on('packet', async (packet) => {
		if (user?.then)
			user = await user;
		try {
			switch (packet.cmd) {
				case 'connect':
					if (packet.username) {
						try {
							user = findAndValidateUser(packet.username, packet.password.toString());
						} catch(error) {
							console.warn(error);
						}
					}
					if (!user)
						return send(generate({ // Send a connection acknowledgment with indication of auth failure
							cmd: 'connack',
							returnCode: 0x86, // bad username or password
						}));

					// TODO: Do we want to prefix the user name to the client id (to prevent collisions when poor ids are used)
					session = await getSession(packet);
					// TODO: Handle the will & testament, and possibly use the will's content type as a hint for expected contet
					session.user = user;
					session.setListener((topic, message) => {
						send(generate({
							cmd: 'publish',
							topic,
							payload: serialize(message),
						}));
					});
					send(generate({ // Send a connection acknowledgment
						cmd: 'connack',
						returnCode: 0, // success
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
					// deserialize
					let deserialize = socket.deserialize || (socket.deserialize = getDeserializer(request?.headers['content-type'], packet.payload));
					let data = packet.payload.length > 0 ? deserialize(packet.payload) :
						undefined; // zero payload length maps to a delete
					let published
					try {
						published = await session.publish(packet, data);
					} catch(error) {
						console.warn(error);
						if (packet.qos > 0) {
							return send(generate({ // Send a subscription acknowledgment
								cmd: 'puback',
								messageId: packet.messageId,
								reasonCode: 0x80, // unspecified error
							}));
						}
					}
					if (packet.qos > 0) {
						if (published === false)
							return send(generate({ // Send a subscription acknowledgment
								cmd: 'puback',
								messageId: packet.messageId,
								reasonCode: 0x90, // Topic name invalid
							}));
						send(generate({ // Send a subscription acknowledgment
							cmd: 'puback',
							messageId: packet.messageId,
							reasonCode: 0 // success
						}));
					}
					break;
				case 'pingreq':
					send(generate({ cmd: 'pingresp' }));
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

