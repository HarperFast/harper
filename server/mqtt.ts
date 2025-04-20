// for now we are using mqtt-packet, but we may implement some of this ourselves, particularly packet generation so that
// we can implement more efficient progressive buffer allocation.
import { parser as makeParser, generate } from 'mqtt-packet';
import { getSession, DurableSubscriptionsSession } from './DurableSubscriptionsSession.ts';
import { getSuperUser } from '../security/user.js';
import { serializeMessage, getDeserializer } from './serverHelpers/contentTypes.ts';
import { recordAction, addAnalyticsListener, recordActionBinary } from '../resources/analytics/write.ts';
import { server } from '../server/Server.ts';
import { get } from '../utility/environment/environmentManager.js';
import { CONFIG_PARAMS, AUTH_AUDIT_STATUS, AUTH_AUDIT_TYPES } from '../utility/hdbTerms.ts';
import { loggerWithTag } from '../utility/logging/logger.js';
import { EventEmitter } from 'events';
const authEventLog = loggerWithTag('auth-event');
const mqttLog = loggerWithTag('mqtt');

let AUTHORIZE_LOCAL = get(CONFIG_PARAMS.AUTHENTICATION_AUTHORIZELOCAL) ?? process.env.DEV_MODE;
export function bypassAuth() {
	AUTHORIZE_LOCAL = true;
}

export function start({ server, port, network, webSocket, securePort, requireAuthentication }) {
	// here we basically normalize the different types of sockets to pass to our socket/message handler
	if (!server.mqtt) {
		server.mqtt = {
			requireAuthentication,
			sessions: new Set(),
			events: new EventEmitter(),
		};
		// a no-op error handler to prevent unhandled error events from being rethrown
		server.mqtt.events.on('error', () => {});
	}
	const mqttSettings = server.mqtt;
	let serverInstances = [];
	const mtls = network?.mtls;
	if (webSocket)
		serverInstances = server.ws(
			(ws, request, chainCompletion, next) => {
				if (request.headers.get('sec-websocket-protocol') !== 'mqtt') {
					return next(ws, request, chainCompletion);
				}

				mqttSettings.events.emit('connection', ws);
				mqttLog.debug?.('Received WebSocket connection for MQTT from', ws._socket.remoteAddress);
				const { onMessage, onClose } = onSocket(
					ws,
					(message) => {
						ws.send(message);
					},
					request,
					Promise.resolve(chainCompletion).then(() => request?.user),
					mqttSettings
				);
				ws.on('message', onMessage);
				ws.on('close', onClose);
				ws.on('error', (error) => {
					mqttLog.info?.('WebSocket error', error);
				});
			},
			{ ...webSocket }
		); // if there is no port, we are piggy-backing off of default app http server
	// standard TCP socket
	if (port || securePort) {
		serverInstances.push(
			server.socket(
				async (socket) => {
					let user;
					mqttSettings.events.emit('connection', socket);
					mqttLog.debug?.(
						`Received ${socket.getCertificate ? 'SSL' : 'TCP'} connection for MQTT from ${socket.remoteAddress}`
					);
					if (mtls) {
						if (socket.authorized) {
							try {
								let username = mtls.user;
								if (username !== null) {
									// null means no user is defined from certificate, need regular authentication as well
									if (username === undefined || username === 'Common Name' || username === 'CN')
										username = socket.getPeerCertificate().subject.CN;
									try {
										user = await server.getUser(username, null, null);
										if (get(CONFIG_PARAMS.LOGGING_AUDITAUTHEVENTS_LOGSUCCESSFUL)) {
											authEventLog.notify?.({
												username: user?.username,
												status: AUTH_AUDIT_STATUS.SUCCESS,
												type: AUTH_AUDIT_TYPES.AUTHENTICATION,
												authStrategy: 'MQTT mTLS',
												remoteAddress: socket.remoteAddress,
											});
										}
									} catch (error) {
										if (get(CONFIG_PARAMS.LOGGING_AUDITAUTHEVENTS_LOGFAILED)) {
											authEventLog.error?.({
												username,
												status: AUTH_AUDIT_STATUS.FAILURE,
												type: AUTH_AUDIT_TYPES.AUTHENTICATION,
												authStrategy: 'mqtt',
												remoteAddress: socket.remoteAddress,
											});
										}
										throw error;
									}
								} else {
									mqttLog.debug?.(
										'MQTT mTLS authorized connection (mTLS did not authorize a user)',
										'from',
										socket.remoteAddress
									);
								}
							} catch (error) {
								mqttSettings.events.emit('error', error, socket);
								mqttLog.error?.(error);
							}
						} else if (mtls.required) {
							mqttLog.info?.(
								`Unauthorized connection attempt, no authorized client certificate provided, error: ${socket.authorizationError}`
							);
							return socket.end();
						}
					}
					if (!user && AUTHORIZE_LOCAL && socket.remoteAddress.includes('127.0.0.1')) {
						user = await getSuperUser();
						mqttLog.debug?.('Auto-authorizing local connection', user?.username);
					}

					const { onMessage, onClose } = onSocket(
						socket,
						(message) => socket.write(message),
						null,
						user,
						mqttSettings
					);
					socket.on('data', onMessage);
					socket.on('close', onClose);
					socket.on('error', (error) => {
						mqttLog.info?.('Socket error', error);
					});
				},
				{ port, securePort, mtls }
			)
		);
	}
	return serverInstances;
}
let addingMetrics,
	numberOfConnections = 0;
function onSocket(socket, send, request, user, mqttSettings) {
	if (!addingMetrics) {
		addingMetrics = true;
		addAnalyticsListener((metrics) => {
			if (numberOfConnections > 0)
				metrics.push({
					metric: 'mqtt-connections',
					connections: numberOfConnections,
					byThread: true,
				});
		});
	}
	let disconnected;
	numberOfConnections++;
	let session: DurableSubscriptionsSession;
	const mqttOptions = { protocolVersion: 4 };
	const parser = makeParser({ protocolVersion: 5 });
	function onMessage(data) {
		parser.parse(data);
	}
	function onClose() {
		numberOfConnections--;
		if (!disconnected) {
			disconnected = true;
			session?.disconnect?.();
			mqttSettings.events.emit('disconnected', session, socket);
			mqttSettings.sessions.delete(session);
			recordActionBinary(false, 'connection', 'mqtt', 'disconnect');
			mqttLog.debug?.('MQTT connection was closed', socket.remoteAddress);
		}
	}

	parser.on('packet', async (packet) => {
		try {
			if (user?.then) user = await user;
		} catch (error) {
			socket.close?.(1008, 'Unauthorized');
			mqttLog.info?.(error); // should already be handled elsewhere
			return;
		}
		const command = packet.cmd;
		if (session) {
			if (session.then) await session;
		} else if (command !== 'connect') {
			mqttLog.info?.('Received packet before connection was established, closing connection');
			if (socket?.destroy) socket.destroy();
			else socket?.terminate();
			return;
		}
		const topic = packet.topic;
		const slashIndex = topic?.indexOf('/', 1);
		const generalTopic = slashIndex > 0 ? topic.slice(0, slashIndex) : topic;
		recordAction(packet.length, 'bytes-received', generalTopic, packetMethodName(packet), 'mqtt');

		try {
			session?.receivedPacket?.();
			switch (command) {
				case 'connect':
					mqttOptions.protocolVersion = packet.protocolVersion;
					if (packet.username) {
						try {
							user = await server.getUser(packet.username, packet.password.toString(), request);
							if (get(CONFIG_PARAMS.LOGGING_AUDITAUTHEVENTS_LOGSUCCESSFUL)) {
								authEventLog.notify?.({
									username: user?.username,
									status: AUTH_AUDIT_STATUS.SUCCESS,
									type: AUTH_AUDIT_TYPES.AUTHENTICATION,
									authStrategy: 'MQTT',
									remoteAddress: socket.remoteAddress,
								});
							}
						} catch (error) {
							if (get(CONFIG_PARAMS.LOGGING_AUDITAUTHEVENTS_LOGFAILED)) {
								authEventLog.error?.({
									username: packet.username,
									status: AUTH_AUDIT_STATUS.FAILURE,
									type: AUTH_AUDIT_TYPES.AUTHENTICATION,
									authStrategy: 'mqtt',
									remoteAddress: socket.remoteAddress,
								});
							}
							mqttSettings.events.emit('auth-failed', packet, socket, error);
							recordActionBinary(false, 'connection', 'mqtt', 'connect');
							return sendPacket({
								// Send a connection acknowledgment with indication of auth failure
								cmd: 'connack',
								reasonCode: 0x04, // bad username or password, v3.1.1
								returnCode: 0x86, // bad username or password, v5
							});
						}
					}
					if (!user && mqttSettings.requireAuthentication) {
						mqttSettings.events.emit('auth-failed', packet, socket);
						recordActionBinary(false, 'connection', 'mqtt', 'connect');
						return sendPacket({
							// Send a connection acknowledgment with indication of auth failure
							cmd: 'connack',
							reasonCode: 0x04, // bad username or password, v3.1.1
							returnCode: 0x86, // bad username or password, v5
						});
					}
					try {
						// TODO: Do we want to prefix the user name to the client id (to prevent collisions when poor ids are used) or is this sufficient?
						mqttSettings.authorizeClient?.(packet, user);

						// TODO: Handle the will & testament, and possibly use the will's content type as a hint for expected content
						if (packet.will) {
							const deserialize =
								socket.deserialize || (socket.deserialize = getDeserializer(request?.headers.get?.('content-type')));
							packet.will.data = packet.will.payload?.length > 0 ? deserialize(packet.will.payload) : undefined;
							delete packet.will.payload;
						}
						session = getSession({
							user,
							...packet,
						});
						session = await session;
						// the session is used in the context, and we want to make sure we can access this
						session.socket = socket;
						if (request) {
							// if there a request, store it in the session so we can use it as part of the context
							session.request = request;
						}
						mqttSettings.sessions.add(session);
					} catch (error) {
						mqttLog.error?.(error);
						mqttSettings.events.emit('auth-failed', packet, socket, error);
						recordActionBinary(false, 'connection', 'mqtt', 'connect');
						return sendPacket({
							// Send a connection acknowledgment with indication of auth failure
							cmd: 'connack',
							reasonCode: error.code || 0x05,
							returnCode: error.code || 0x80, // generic error
						});
					}
					mqttSettings.events.emit('connected', session, socket);
					recordActionBinary(true, 'connection', 'mqtt', 'connect');
					sendPacket({
						// Send a connection acknowledgment
						cmd: 'connack',
						sessionPresent: session.sessionWasPresent,
						reasonCode: 0,
						returnCode: 0, // success
					});
					const listener = async (topic, message, messageId, subscription) => {
						try {
							if (disconnected) throw new Error('Session disconnected while trying to send message to', topic);
							const slashIndex = topic.indexOf('/', 1);
							const generalTopic = slashIndex > 0 ? topic.slice(0, slashIndex) : topic;
							sendPacket(
								{
									cmd: 'publish',
									topic,
									payload: await serialize(message),
									messageId: messageId || Math.floor(Math.random() * 100000000),
									qos: subscription.qos,
								},
								generalTopic
							);
							// wait if there is back-pressure
							const rawSocket = socket._socket ?? socket;
							if (rawSocket.writableNeedDrain) {
								return new Promise((resolve) => rawSocket.once('drain', resolve));
							}
							return !rawSocket.closed;
						} catch (error) {
							mqttLog.error?.(error);
							session?.disconnect();
							mqttSettings.sessions.delete(session);
							return false;
						}
					};
					session.setListener(listener);
					if (session.sessionWasPresent) await session.resume();
					break;
				case 'subscribe':
					const granted = [];
					for (const subscription of packet.subscriptions) {
						let grantedQos;
						try {
							const grantedSubscription = await session.addSubscription(subscription, subscription.qos >= 1);
							grantedQos = grantedSubscription
								? grantedSubscription.qos || 0
								: mqttOptions.protocolVersion < 5
									? 0x80 // only error code in v3.1.1
									: 0x8f; // invalid topic indicated
						} catch (error) {
							mqttSettings.events.emit('error', error, socket, subscription, session);
							if (error.statusCode) {
								if (error.statusCode === 500) mqttLog.warn?.(error);
								else mqttLog.info?.(error);
							} else mqttLog.error?.(error);
							grantedQos =
								mqttOptions.protocolVersion < 5
									? 0x80 // the only error code in v3.1.1
									: error.statusCode === 403
										? 0x87 // unauthorized
										: error.statusCode === 404
											? 0x8f // invalid topic
											: 0x80; // generic failure
						}
						granted.push(grantedQos);
					}
					await session.committed;
					sendPacket({
						// Send a subscription acknowledgment
						cmd: 'suback',
						granted,
						messageId: packet.messageId,
					});
					break;
				case 'unsubscribe': {
					const granted = [];
					for (const subscription of packet.unsubscriptions) {
						granted.push(session.removeSubscription(subscription) ? 0 : 17);
					}
					sendPacket({
						// Send a subscription acknowledgment
						cmd: 'unsuback',
						granted,
						messageId: packet.messageId,
					});
					break;
				}
				case 'pubrel':
					sendPacket({
						// Send a publish response
						cmd: 'pubcomp',
						messageId: packet.messageId,
						reasonCode: 0,
					});
					return;
				case 'publish':
					const responseCmd = packet.qos === 2 ? 'pubrec' : 'puback';
					// deserialize
					const deserialize =
						socket.deserialize || (socket.deserialize = getDeserializer(request?.headers.get?.('content-type')));
					const messageLength = packet.payload?.length || 0;
					const data = messageLength > 0 ? deserialize(packet.payload) : undefined; // zero payload length maps to a delete
					let published;
					try {
						published = await session.publish(packet, data);
					} catch (error) {
						mqttSettings.events.emit('error', error, socket, packet, session);
						mqttLog.warn?.(error);
						if (packet.qos > 0) {
							sendPacket(
								{
									// Send a publish acknowledgment
									cmd: responseCmd,
									messageId: packet.messageId,
									reasonCode: 0x80, // unspecified error (only MQTT v5 supports error codes)
								},
								packet.topic
							);
						}
						break;
					}
					if (packet.qos > 0) {
						sendPacket(
							{
								// Send a publish acknowledgment
								cmd: responseCmd,
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
					session?.disconnect(true);
					mqttSettings.events.emit('disconnected', session, socket);
					mqttSettings.sessions.delete(session);
					recordActionBinary(true, 'connection', 'mqtt', 'disconnect');
					mqttLog.debug?.('Received disconnect command, closing MQTT session', socket.remoteAddress);
					if (socket.close) socket.close();
					else socket.end();
					break;
			}
		} catch (error) {
			mqttSettings.events.emit('error', error, socket, packet, session);
			mqttLog.error?.(error);
			sendPacket({
				// Send a subscription acknowledgment
				cmd: 'disconnect',
			});
		}
		function sendPacket(packetData, path?) {
			const send_packet = generate(packetData, mqttOptions);
			send(send_packet);
			recordAction(send_packet.length, 'bytes-sent', path, packetMethodName(packetData), 'mqtt');
		}
		function packetMethodName(packet) {
			return packet.qos > 0 ? packet.cmd + ',qos=' + packet.qos : packet.cmd;
		}
		function serialize(data) {
			return serializeMessage(data, request);
		}
	});
	parser.on('error', (error) => {
		mqttLog.warn('MQTT parsing error, closing connection:', error.message);
		if (socket?.destroy) socket.destroy();
		else socket?.terminate();
	});
	return { onMessage, onClose };
}
