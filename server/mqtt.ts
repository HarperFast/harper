// for now we are using mqtt-packet, but we may implement some of this ourselves, particularly packet generation so that
// we can implement more efficient progressive buffer allocation.
import { parser as makeParser, generate } from 'mqtt-packet';
import { getSession, DurableSubscriptionsSession } from './DurableSubscriptionsSession';
import { findAndValidateUser, getSuperUser } from '../security/user';
import { serializeMessage, getDeserializer } from './serverHelpers/contentTypes';
import { info } from '../utility/logging/harper_logger';
import { recordAction } from '../resources/analytics';
import { server } from '../server/Server';
import { pack } from 'msgpackr';
import { get } from '../utility/environment/environmentManager.js';
import { CONFIG_PARAMS, AUTH_AUDIT_STATUS, AUTH_AUDIT_TYPES } from '../utility/hdbTerms';
import { loggerWithTag, AuthAuditLog } from '../utility/logging/harper_logger.js';
const auth_event_log = loggerWithTag('auth-event');

const AUTHORIZE_LOCAL = true;
export async function start({ server, port, webSocket, securePort, requireAuthentication }) {
	// here we basically normalize the different types of sockets to pass to our socket/message handler
	if (webSocket)
		server.ws(
			(ws, request, chain_completion) => {
				if (ws.protocol === 'mqtt') {
					const { onMessage, onClose } = onSocket(
						ws,
						(message) => ws.send(message),
						request,
						Promise.resolve(chain_completion).then(() => request?.user),
						requireAuthentication
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

				const { onMessage, onClose } = onSocket(
					socket,
					(message) => socket.write(message),
					null,
					user,
					requireAuthentication
				);
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

function onSocket(socket, send, request, user, requireAuthentication) {
	let session: DurableSubscriptionsSession;
	const mqtt_options = { protocolVersion: 4 };
	const parser = makeParser({ protocolVersion: 5 });
	function onMessage(data) {
		parser.parse(data);
	}
	function onClose() {
		session.disconnect();
	}
	let awaiting_acks: Map;

	parser.on('packet', async (packet) => {
		if (user?.then) user = await user;
		try {
			switch (packet.cmd) {
				case 'connect':
					mqtt_options.protocolVersion = packet.protocolVersion;
					if (packet.username) {
						try {
							user = await server.auth(packet.username, packet.password.toString());
							if (get(CONFIG_PARAMS.LOGGING_AUDITAUTHEVENTS_LOGSUCCESSFUL)) {
								auth_event_log.notify({
									username: user.username,
									status: AUTH_AUDIT_STATUS.SUCCESS,
									type: AUTH_AUDIT_TYPES.AUTHENTICATION,
									auth_strategy: 'MQTT',
									remote_address: socket.remoteAddress,
								});
							}
						} catch (error) {
							if (get(CONFIG_PARAMS.LOGGING_AUDITAUTHEVENTS_LOGFAILED)) {
								auth_event_log.error({
									username: user.username,
									status: AUTH_AUDIT_STATUS.FAILURE,
									type: AUTH_AUDIT_TYPES.AUTHENTICATION,
									auth_strategy: 'mqtt',
									remote_address: socket.remoteAddress,
								});
							}

							return sendPacket({
								// Send a connection acknowledgment with indication of auth failure
								cmd: 'connack',
								reasonCode: 0x86,
								returnCode: 0x86, // bad username or password
							});
						}
					}
					if (!user && requireAuthentication)
						return sendPacket({
							// Send a connection acknowledgment with indication of auth failure
							cmd: 'connack',
							reasonCode: 0x86,
							returnCode: 0x86, // bad username or password
						});
					// TODO: Do we want to prefix the user name to the client id (to prevent collisions when poor ids are used)
					// TODO: Handle the will & testament, and possibly use the will's content type as a hint for expected content
					session = await getSession({
						user,
						...packet,
					});
					sendPacket({
						// Send a connection acknowledgment
						cmd: 'connack',
						sessionPresent: session.sessionWasPresent,
						reasonCode: 0,
						returnCode: 0, // success
					});
					session.setListener((topic, message, message_id, subscription) => {
						try {
							const slash_index = topic.indexOf('/', 1);
							const general_topic = slash_index > 0 ? topic.slice(0, slash_index) : topic;
							sendPacket(
								{
									cmd: 'publish',
									topic,
									payload: serialize(message),
									messageId: message_id || Math.floor(Math.random() * 100),
									qos: subscription.qos,
								},
								general_topic
							);
						} catch (error) {
							console.warn(error);
							session.disconnect();
						}
					});
					if (session.sessionWasPresent) await session.resume();
					break;
				case 'subscribe':
					const granted = [];
					info('Received subscription request', packet.subscriptions);
					for (const subscription of packet.subscriptions) {
						granted.push((await session.addSubscription(subscription, subscription.qos >= 1)) || 0);
					}
					await session.committed;
					info('Sending suback', packet.subscriptions[0].topic);
					sendPacket({
						// Send a subscription acknowledgment
						cmd: 'suback',
						granted,
						messageId: packet.messageId,
					});
					info('Sent suback');
					break;
				case 'unsubscribe':
					info('Received unsubscribe request', packet.unsubscriptions);
					for (const subscription of packet.unsubscriptions) {
						session.removeSubscription(subscription);
					}
					sendPacket({
						// Send a subscription acknowledgment
						cmd: 'unsuback',
						messageId: packet.messageId,
					});
					break;
				case 'pubrel':
					sendPacket({
						// Send a publish response
						cmd: 'pubcomp',
						messageId: packet.messageId,
						reasonCode: 0,
					});
					return;
				case 'publish':
					const response_cmd = packet.qos === 2 ? 'pubrec' : 'puback';
					// deserialize
					const deserialize =
						socket.deserialize || (socket.deserialize = getDeserializer(request?.headers['content-type']));
					const data = packet.payload?.length > 0 ? deserialize(packet.payload) : undefined; // zero payload length maps to a delete
					let published;
					try {
						published = await session.publish(packet, data);
					} catch (error) {
						console.warn(error);
						if (packet.qos > 0) {
							sendPacket(
								{
									// Send a publish acknowledgment
									cmd: response_cmd,
									messageId: packet.messageId,
									reasonCode: 0x80, // unspecified error
								},
								packet.topic
							);
						}
					}
					if (packet.qos > 0) {
						sendPacket(
							{
								// Send a publish acknowledgment
								cmd: response_cmd,
								messageId: packet.messageId,
								reasonCode:
									published === false
										? 0x90 // Topic name invalid
										: 0, //success
							},
							packet.topic
						);
					}
					break;
				case 'pubrec':
					sendPacket({
						// Send a publish response
						cmd: 'pubrel',
						messageId: packet.messageId,
						reasonCode: 0,
					});
					break;
				case 'pubcomp':
				case 'puback':
					session.acknowledge(packet.messageId);
					break;
				case 'pingreq':
					sendPacket({ cmd: 'pingresp' });
					break;
				case 'disconnect':
					session.disconnect();
					if (socket.close) socket.close();
					else socket.end();
					break;
			}
		} catch (error) {
			console.error(error);
			sendPacket({
				// Send a subscription acknowledgment
				cmd: 'disconnect',
			});
		}
		function sendPacket(packet_data, path?) {
			const send_packet = generate(packet_data, mqtt_options);
			send(send_packet);
			recordAction(send_packet.length, 'bytes-sent', path, packet_data.cmd, 'mqtt');
		}
		function serialize(data) {
			return request ? serializeMessage(data, request) : JSON.stringify(data);
		}
	});
	return { onMessage, onClose };
}
