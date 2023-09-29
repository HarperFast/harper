// for now we are using mqtt-packet, but we may implement some of this ourselves, particularly packet generation so that
// we can implement more efficient progressive buffer allocation.
import { parser as makeParser, generate } from 'mqtt-packet';
import { getSession, DurableSubscriptionsSession } from './DurableSubscriptionsSession';
import { getSuperUser } from '../security/user';
import { serializeMessage, getDeserializer } from './serverHelpers/contentTypes';
import { recordAction, addAnalyticsListener, recordActionBinary } from '../resources/analytics';
import { server } from '../server/Server';
import { get } from '../utility/environment/environmentManager.js';
import { CONFIG_PARAMS, AUTH_AUDIT_STATUS, AUTH_AUDIT_TYPES } from '../utility/hdbTerms';
import { loggerWithTag, error as log_error, warn, info } from '../utility/logging/harper_logger.js';
const auth_event_log = loggerWithTag('auth-event');

const AUTHORIZE_LOCAL = true;
export async function start({ server, port, webSocket, securePort, requireAuthentication }) {
	// here we basically normalize the different types of sockets to pass to our socket/message handler
	const mqtt_settings = (server.mqtt = { requireAuthentication });
	if (webSocket)
		server.ws(
			(ws, request, chain_completion) => {
				if (ws.protocol === 'mqtt') {
					const { onMessage, onClose } = onSocket(
						ws,
						(message, allow_backpressure) => {
							ws.send(message);
							// This can be used for back-pressure. Most of the time with real-time data, it is probably more
							// efficient to immediately deliver and let the buffers queue the data, but when iterating through
							// a database/audit log, we could employ back-pressure to do this with less memory pressure
							if (allow_backpressure && ws._socket.writableNeedDrain)
								return new Promise((resolve) => this._socket.once('drain', resolve));
						},
						request,
						Promise.resolve(chain_completion).then(() => request?.user),
						mqtt_settings
					);
					ws.on('message', onMessage);
					ws.on('close', onClose);
					ws.on('error', (error) => {
						info('WebSocket error', error);
					});
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

				const { onMessage, onClose } = onSocket(socket, (message) => socket.write(message), null, user, mqtt_settings);
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
let adding_metrics,
	number_of_connections = 0;
function onSocket(socket, send, request, user, mqtt_settings) {
	if (!adding_metrics) {
		adding_metrics = true;
		addAnalyticsListener((metrics) => {
			if (number_of_connections > 0)
				metrics.push({
					metric: 'mqtt-connections',
					connections: number_of_connections,
					byThread: true,
				});
		});
	}
	let disconnected;
	number_of_connections++;
	let session: DurableSubscriptionsSession;
	const mqtt_options = { protocolVersion: 4 };
	const parser = makeParser({ protocolVersion: 5 });
	function onMessage(data) {
		parser.parse(data);
	}
	function onClose() {
		number_of_connections--;
		if (!disconnected) {
			disconnected = true;
			session?.disconnect();
			recordActionBinary(false, 'connection', 'mqtt', 'disconnect');
		}
	}

	parser.on('packet', async (packet) => {
		if (user?.then) user = await user;
		if (session?.then) await session;
		try {
			switch (packet.cmd) {
				case 'connect':
					mqtt_options.protocolVersion = packet.protocolVersion;
					if (packet.username) {
						try {
							user = await server.getUser(packet.username, packet.password.toString());
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
					if (!user && mqtt_settings.requireAuthentication) {
						recordActionBinary(false, 'connection', 'mqtt', 'connect');
						return sendPacket({
							// Send a connection acknowledgment with indication of auth failure
							cmd: 'connack',
							reasonCode: 0x86,
							returnCode: 0x86, // bad username or password
						});
					}
					try {
						// TODO: Do we want to prefix the user name to the client id (to prevent collisions when poor ids are used) or is this sufficient?
						mqtt_settings.authorizeClient?.(packet, user);

						// TODO: Handle the will & testament, and possibly use the will's content type as a hint for expected content
						session = getSession({
							user,
							...packet,
						});
						session = await session;
					} catch (error) {
						log_error(error);
						recordActionBinary(false, 'connection', 'mqtt', 'connect');
						return sendPacket({
							// Send a connection acknowledgment with indication of auth failure
							cmd: 'connack',
							reasonCode: error.code || 0x80,
							returnCode: error.code || 0x80, // generic error
						});
					}
					recordActionBinary(true, 'connection', 'mqtt', 'connect');
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
									messageId: message_id || Math.floor(Math.random() * 100000000),
									qos: subscription.qos,
								},
								general_topic
							);
						} catch (error) {
							log_error(error);
							session?.disconnect();
						}
					});
					if (session.sessionWasPresent) await session.resume();
					break;
				case 'subscribe':
					const granted = [];
					for (const subscription of packet.subscriptions) {
						let granted_qos;
						try {
							granted_qos = (await session.addSubscription(subscription, subscription.qos >= 1)).qos || 0;
						} catch (error) {
							log_error(error);
							granted_qos = 0x80; // failure
						}
						granted.push(granted_qos);
					}
					await session.committed;
					sendPacket({
						// Send a subscription acknowledgment
						cmd: 'suback',
						granted,
						messageId: packet.messageId,
					});
					break;
				case 'unsubscribe':
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
						socket.deserialize || (socket.deserialize = getDeserializer(request?.headers.get?.('content-type')));
					const data = packet.payload?.length > 0 ? deserialize(packet.payload) : undefined; // zero payload length maps to a delete
					let published;
					try {
						published = await session.publish(packet, data);
					} catch (error) {
						warn(error);
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
					disconnected = true;
					session?.disconnect();
					recordActionBinary(true, 'connection', 'mqtt', 'disconnect');
					if (socket.close) socket.close();
					else socket.end();
					break;
			}
		} catch (error) {
			log_error(error);
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
