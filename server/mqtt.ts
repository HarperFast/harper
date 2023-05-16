// for now we are using mqtt-packet, but we may implement some of this ourselves, particularly packet generation so that
// we can implement more efficient progressive buffer allocation.
import { parser as makeParser, generate } from 'mqtt-packet';
import { getSession, DurableSubscriptionsSession } from './DurableSubscriptionsSession';
import { findAndValidateUser, getSuperUser } from '../security/user';
import { serializeMessage, getDeserializer } from './serverHelpers/contentTypes';
import { info } from '../utility/logging/harper_logger';
import { recordAction } from '../resources/analytics';

const DEFAULT_MQTT_PORT = 1883;
const AUTHORIZE_LOCAL = true;
export async function start({ server, port, webSocket, securePort }) {
	// here we basically normalize the different types of sockets to pass to our socket/message handler
	if (webSocket)
		server.ws(
			(ws, request, chain_completion) => {
				if (ws.protocol === 'mqtt') {
					const { onMessage, onClose } = onSocket(
						ws,
						(message) => ws.send(message),
						request,
						Promise.resolve(chain_completion).then(() => request?.user)
					);
					ws.on('message', onMessage);
					ws.on('close', onClose);
				}
			},
			{ subProtocol: 'mqtt' }
		); // if there is no port, we are piggy-backing off of default app http server
	// standard TCP socket
	if (port || securePort) {
		server.socket(
			async (socket) => {
				let user;
				if (AUTHORIZE_LOCAL && socket.remoteAddress.includes('127.0.0.1')) {
					user = await getSuperUser();
				}

				const { onMessage, onClose } = onSocket(socket, (message) => socket.write(message), null, user);
				socket.on('data', onMessage);
				socket.on('close', onClose);
				socket.on('error', (error) => {
					info('Socket error', error);
				});
			},
			{ port, securePort }
		);
	}
}

function onSocket(socket, send, request, user) {
	let session: DurableSubscriptionsSession;
	const parser = makeParser({ protocolVersion: 4 });
	function onMessage(data) {
		parser.parse(data);
	}
	function onClose() {
		session.disconnect();
	}

	parser.on('packet', async (packet) => {
		if (user?.then) user = await user;
		try {
			switch (packet.cmd) {
				case 'connect':
					if (packet.username) {
						try {
							user = findAndValidateUser(packet.username, packet.password.toString());
						} catch (error) {
							console.warn(error);
						}
					}
					if (!user)
						return send(
							generate({
								// Send a connection acknowledgment with indication of auth failure
								cmd: 'connack',
								returnCode: 0x86, // bad username or password
							})
						);

					// TODO: Do we want to prefix the user name to the client id (to prevent collisions when poor ids are used)
					session = await getSession(packet);
					// TODO: Handle the will & testament, and possibly use the will's content type as a hint for expected contet
					session.user = user;
					session.setListener((topic, message) => {
						const payload = generate({
							cmd: 'publish',
							topic,
							payload: serialize(message),
						});
						try {
							const slash_index = topic.indexOf('/', 1);
							const general_topic = slash_index > 0 ? topic.slice(0, slash_index) : topic;
							send(payload);
							recordAction(payload.length, 'bytes-sent', general_topic, 'deliver', 'mqtt');
						} catch (error) {
							console.warn(error);
							session.disconnect();
						}
					});
					send(
						generate({
							// Send a connection acknowledgment
							cmd: 'connack',
							returnCode: 0, // success
						})
					);
					break;
				case 'subscribe':
					const granted = [];
					info('Received subscription request', packet.subscriptions);
					for (const subscription of packet.subscriptions) {
						granted.push((await session.addSubscription(subscription)) || 0);
					}
					await session.committed;
					info('Sending suback', packet.subscriptions[0].topic);
					const payload = generate({
						// Send a subscription acknowledgment
						cmd: 'suback',
						granted,
						messageId: packet.messageId,
					});
					send(payload);
					recordAction(payload.length, 'bytes-sent', null, 'suback', 'mqtt');
					info('Sent suback');
					break;
				case 'unsubscribe':
					info('Received unsubscribe request', packet.unsubscriptions);
					for (const subscription of packet.unsubscriptions) {
						session.removeSubscription(subscription);
					}
					send(
						generate({
							// Send a subscription acknowledgment
							cmd: 'unsuback',
							messageId: packet.messageId,
						})
					);
					break;
				case 'publish':
					// deserialize
					const deserialize =
						socket.deserialize ||
						(socket.deserialize = getDeserializer(request?.headers['content-type'], packet.payload));
					const data = packet.payload.length > 0 ? deserialize(packet.payload) : undefined; // zero payload length maps to a delete
					let published;
					try {
						published = await session.publish(packet, data);
					} catch (error) {
						console.warn(error);
						if (packet.qos > 0) {
							const payload = generate({
								// Send a publish acknowledgment
								cmd: 'puback',
								messageId: packet.messageId,
								reasonCode: 0x80, // unspecified error
							});
							send(payload);
							recordAction(payload.length, 'bytes-sent', null, 'puback', 'mqtt');
						}
					}
					if (packet.qos > 0) {
						let payload;
						if (published === false)
							payload = generate({
								// Send a publish acknowledgment
								cmd: 'puback',
								messageId: packet.messageId,
								reasonCode: 0x90, // Topic name invalid
							});
						else
							payload = generate({
								// Send a publish acknowledgment
								cmd: 'puback',
								messageId: packet.messageId,
								reasonCode: 0, // success
							});
						send(payload);
						recordAction(payload.length, 'bytes-sent', null, 'puback', 'mqtt');
					}
					break;
				case 'pingreq':
					send(generate({ cmd: 'pingresp' }));
					break;
				case 'disconnect':
					session.disconnect();
					if (socket.close) socket.close();
					else socket.end();
					break;
			}
		} catch (error) {
			console.error(error);
			send(
				generate({
					// Send a subscription acknowledgment
					cmd: 'disconnect',
				})
			);
		}
		function serialize(data) {
			return request ? serializeMessage(data, request) : JSON.stringify(data);
		}
	});
	return { onMessage, onClose };
}
