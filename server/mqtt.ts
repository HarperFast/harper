// for now we are using mqtt-packet, but we may implement some of this ourselves, particularly packet generation so that
// we can implement more efficient progressive buffer allocation.
import { parser as makeParser, generate } from 'mqtt-packet';
import { getSession, DurableSubscriptionsSession } from './DurableSubscriptionsSession.ts';
import { getSuperUser } from '../security/user.ts';
import { getDeserializer } from './serverHelpers/contentTypes.ts';
import {
	getSharedMessageEncoding,
	getSharedFrame,
	setSharedFrame,
	resolveSharedPayload,
} from './serverHelpers/sharedMessageEncoding.ts';
import { recordAction, addAnalyticsListener, recordActionBinary } from '../resources/analytics/write.ts';
import { server } from '../server/Server.ts';
import { get } from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS, AUTH_AUDIT_STATUS, AUTH_AUDIT_TYPES } from '../utility/hdbTerms.ts';
import { loggerWithTag } from '../utility/logging/logger.ts';
import { forComponent as loggerForComponent } from '../utility/logging/harper_logger.ts';
import { EventEmitter } from 'events';
import { verifyCertificate } from '../security/certificateVerification/index.ts';
import { registerShutdownDrain } from '../components/shutdownDrain.ts';
import {
	assertNoDeferredCredentialRejection,
	getDeferredCredentialRejection,
} from '../security/deferredAuthentication.ts';

/** RFC 6455 private-use close code Harper already maps HTTP 401 to (see server/REST.ts). */
const WEBSOCKET_UNAUTHORIZED_CLOSE_CODE = 3000;
const authEventLog = loggerWithTag('auth-event');
const mqttLog = loggerForComponent('mqtt');

let AUTHORIZE_LOCAL = get(CONFIG_PARAMS.AUTHENTICATION_AUTHORIZELOCAL) ?? process.env.DEV_MODE;
export function bypassAuth() {
	AUTHORIZE_LOCAL = true;
}

const authorizeLocal = (remoteAddress: string) =>
	AUTHORIZE_LOCAL && (remoteAddress.includes('127.0.0.') || remoteAddress === '::1');

export function handleApplication(scope: import('../components/Scope.ts').Scope) {
	const { network, webSocket, requireAuthentication } = scope.options.getAll() as {
		network?: any;
		webSocket?: any;
		requireAuthentication?: boolean;
	};
	const server = scope.server;
	const { port, securePort } = network ?? {};
	// here we basically normalize the different types of sockets to pass to our socket/message handler
	if (!(server as any).mqtt) {
		(server as any).mqtt = {
			requireAuthentication,
			sessions: new Set(),
			events: new EventEmitter(),
		};
		// a no-op error handler to prevent unhandled error events from being rethrown
		(server as any).mqtt.events.on('error', () => {});
		registerShutdownDisconnect();
	}
	const mqttSettings = (server as any).mqtt;
	function emitEvent(type: string, ...args: any[]) {
		try {
			mqttSettings.events.emit(type, ...args);
		} catch (error) {
			mqttLog.warn?.(`Error emitting MQTT event '${type}':`, error);
		}
	}
	let serverInstances = [];
	const mtls = network?.mtls;
	if (webSocket)
		serverInstances = (server as any).ws(
			(ws, request, chainCompletion, next: any) => {
				if (request.headers.get('sec-websocket-protocol') !== 'mqtt') {
					return next(ws, request, chainCompletion);
				}

				emitEvent('connection', ws);
				mqttLog.debug?.('Received WebSocket connection for MQTT from', ws._socket.remoteAddress);
				// Both WebSocket entry points invoke this listener synchronously with the HTTP chain still
				// pending (server/http.ts), so authentication has not recorded a credential rejection yet.
				// It settles on the same promise the session principal comes from, which onSocket awaits
				// before it processes any packet — the handlers below still attach synchronously, so no
				// frame that arrives in the meantime is dropped.
				const authenticated = Promise.resolve(chainCompletion).then(() => {
					assertNoDeferredCredentialRejection(request);
					return request?.user;
				});
				authenticated.catch((error) => {
					mqttLog.info?.('Closing MQTT WebSocket connection, authentication was rejected', error);
					ws.close(
						WEBSOCKET_UNAUTHORIZED_CLOSE_CODE,
						getDeferredCredentialRejection(request)?.message ?? 'Unauthorized'
					);
				});
				const { onMessage, onClose } = onSocket(
					ws,
					(message) => {
						ws.send(message);
					},
					request,
					authenticated,
					mqttSettings
				);
				ws.on('message', onMessage);
				ws.on('close', onClose);
				ws.on('error', (error) => {
					mqttLog.info?.('WebSocket error', error);
				});
			},
			{ ...webSocket, after: 'authentication' }
		); // if there is no port, we are piggy-backing off of default app http server
	// standard TCP socket
	if (port || securePort) {
		serverInstances.push(
			server.socket(
				async (socket) => {
					let user;
					emitEvent('connection', socket);
					mqttLog.debug?.(
						`Received ${(socket as any).getCertificate ? 'SSL' : 'TCP'} connection for MQTT from ${socket.remoteAddress}`
					);
					if (mtls) {
						if ((socket as any).authorized) {
							try {
								// Perform certificate verification
								const peerCertificate = (socket as any).getPeerCertificate(true);
								if (peerCertificate?.subject) {
									const verificationResult = await verifyCertificate(peerCertificate, mtls);
									if (!verificationResult.valid) {
										mqttLog.error?.(
											'Certificate verification failed:',
											verificationResult.status,
											'for',
											peerCertificate.subject.CN
										);
										throw new Error('Certificate revoked or verification failed');
									}
								}

								let username = mtls.user;
								if (username !== null) {
									// null means no user is defined from certificate, need regular authentication as well
									if (username === undefined || username === 'Common Name' || username === 'CN')
										username = (socket as any).getPeerCertificate().subject.CN;
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
								emitEvent('error', error, socket);
								mqttLog.error?.(error);
							}
						} else if (mtls.required) {
							mqttLog.info?.(
								`Unauthorized connection attempt, no authorized client certificate provided, error: ${(socket as any).authorizationError}`
							);
							return socket.end();
						}
					}
					if (!user && authorizeLocal(socket.remoteAddress)) {
						user = await getSuperUser();
						mqttLog.debug?.('Auto-authorizing local connection', user?.username);
					}

					const { onMessage, onClose } = onSocket(socket, (message) => socket.write(message), null, user, mqttSettings);
					socket.on('data', onMessage);
					socket.on('close', onClose);
					socket.on('error', (error) => {
						mqttLog.info?.('Socket error', error);
					});
				},
				{ port, securePort, mtls, usageType: 'mqtt' }
			)
		);
	}
}
const SERVER_SHUTTING_DOWN = 0x8b; // MQTT v5 DISCONNECT reason code
const REASON_STRING_LIMIT = 256; // bytes
/** Fixed header, message id and reason code, plus the property identifier and its length prefix. */
const ACK_PACKET_OVERHEAD = 16;

/**
 * Every live MQTT connection on this worker, so a shutdown can announce itself: a bare socket close
 * is indistinguishable to the client from a network failure.
 */
const liveConnections = new Set<{ protocolVersion: () => number; send: (data: any) => void; close: () => void }>();
let shutdownDisconnectRegistered = false;

/** v3.1.1 has no server-to-client DISCONNECT, so those connections are only closed. */
export function disconnectClientsForShutdown() {
	if (liveConnections.size === 0) return;
	const disconnectPacket = generate({ cmd: 'disconnect', reasonCode: SERVER_SHUTTING_DOWN } as any, {
		protocolVersion: 5,
	});
	for (const connection of liveConnections) {
		try {
			if (connection.protocolVersion() >= 5) connection.send(disconnectPacket);
		} catch (error) {
			mqttLog.debug?.('Could not notify MQTT connection of shutdown', error);
		} finally {
			try {
				connection.close();
			} catch (error) {
				mqttLog.debug?.('Could not close MQTT connection during shutdown', error);
			}
		}
	}
	liveConnections.clear();
}

function registerShutdownDisconnect() {
	if (shutdownDisconnectRegistered) return;
	shutdownDisconnectRegistered = true;
	registerShutdownDrain({
		// Notifying clients is bounded and synchronous; it must never extend the shutdown deadline.
		hasWork: () => false,
		drain: async () => disconnectClientsForShutdown(),
	});
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
	function emitEvent(type: string, ...args: any[]) {
		try {
			mqttSettings.events.emit(type, ...args);
		} catch (error) {
			mqttLog.warn?.(`Error emitting MQTT event '${type}':`, error);
		}
	}
	let disconnected;
	numberOfConnections++;
	const connection = {
		protocolVersion: () => mqttOptions.protocolVersion,
		send,
		close: () => (socket.close ? socket.close() : socket.end()),
	};
	liveConnections.add(connection);
	let session: DurableSubscriptionsSession;
	// [MQTT-3.1.2-29]: a client that asks for no problem information must not be sent a reason
	// string on a PUBACK/PUBREC, and [MQTT-3.1.2-24] caps what it will accept at all.
	let sendProblemInformation = true;
	let maximumPacketSize: number | undefined;
	const mqttOptions = { protocolVersion: 4 };
	const parser = makeParser({ protocolVersion: 5 });
	function onMessage(data) {
		parser.parse(data);
	}
	function onClose() {
		numberOfConnections--;
		liveConnections.delete(connection);
		if (!disconnected) {
			disconnected = true;
			session?.disconnect?.(false);
			emitEvent('disconnected', session, socket);
			mqttSettings.sessions.delete(session);
			recordActionBinary(false, 'connection', 'mqtt', 'disconnect');
			mqttLog.debug?.('MQTT connection was closed', socket.remoteAddress);
		}
	}

	parser.on('packet', async (packet: any) => {
		try {
			if (user?.then) user = await user;
		} catch (error) {
			socket.close?.(1008, 'Unauthorized');
			mqttLog.info?.(error); // should already be handled elsewhere
			return;
		}
		const command = packet.cmd;
		if (session) {
			if ((session as any).then) await session;
		} else if (command !== 'connect') {
			mqttLog.info?.('Received packet before connection was established, closing connection');
			if (socket?.destroy) socket.destroy();
			else socket?.terminate();
			return;
		}
		const topic = (packet as any).topic;
		const slashIndex = topic?.indexOf('/', 1);
		const generalTopic = slashIndex > 0 ? topic.slice(0, slashIndex) : topic;
		recordAction(packet.length, 'bytes-received', generalTopic, packetMethodName(packet), 'mqtt');

		try {
			session?.receivedPacket?.();
			switch (command) {
				case 'connect':
					mqttOptions.protocolVersion = packet.protocolVersion;
					// mqtt-packet parses this byte into a boolean, and a client may also send the raw 0.
					const requestProblemInformation = packet.properties?.requestProblemInformation;
					sendProblemInformation = requestProblemInformation !== false && requestProblemInformation !== 0;
					maximumPacketSize = packet.properties?.maximumPacketSize;
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
							emitEvent('auth-failed', packet, socket, error);
							recordActionBinary(false, 'connection', 'mqtt', 'connect');
							return generateAndSendPacket({
								// Send a connection acknowledgment with indication of auth failure
								cmd: 'connack',
								reasonCode: 0x04, // bad username or password, v3.1.1
								returnCode: 0x86, // bad username or password, v5
							});
						}
					}
					if (!user && mqttSettings.requireAuthentication) {
						emitEvent('auth-failed', packet, socket);
						recordActionBinary(false, 'connection', 'mqtt', 'connect');
						return generateAndSendPacket({
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
								socket.deserialize ||
								(socket.deserialize = getDeserializer(request?.headers.get?.('content-type') as string, false));
							(packet.will as any).data =
								packet.will.payload?.length > 0 ? deserialize(packet.will.payload) : undefined;
							delete packet.will.payload;
						}
						session = getSession({
							user,
							...packet,
						} as any) as any;
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
						emitEvent('auth-failed', packet, socket, error);
						recordActionBinary(false, 'connection', 'mqtt', 'connect');
						return generateAndSendPacket({
							// Send a connection acknowledgment with indication of auth failure
							cmd: 'connack',
							reasonCode: error.code || 0x05,
							returnCode: error.code || 0x80, // generic error
						});
					}
					emitEvent('connected', session, socket);
					recordActionBinary(true, 'connection', 'mqtt', 'connect');
					generateAndSendPacket({
						// Send a connection acknowledgment
						cmd: 'connack',
						sessionPresent: session.sessionWasPresent,
						reasonCode: 0,
						returnCode: 0, // success
					});
					const listener = async (topic, message, messageId, subscription, version) => {
						try {
							if (disconnected) throw new Error('Session disconnected while trying to send message to', topic);
							const slashIndex = topic.indexOf('/', 1);
							const generalTopic = slashIndex > 0 ? topic.slice(0, slashIndex) : topic;
							const qos = subscription.qos || 0;
							// Every subscriber of a topic serializes the same message to the same bytes, so the
							// payload is encoded once per (message, content type) and reused across all of them.
							const encoding = getSharedMessageEncoding(message, request, version);
							const encoded = encoding.payload;
							// only pay for a microtask when the serialization is genuinely still pending
							const payload =
								typeof (encoded as any)?.then === 'function'
									? await resolveSharedPayload(encoding, message, request, version)
									: (encoded as Buffer | string);
							if (qos > 0) {
								// mqtt-packet requires a numeric message identifier once qos is non-zero
								const packetData: any = {
									cmd: 'publish',
									topic,
									payload,
									messageId: messageId || Math.floor(Math.random() * 100000000),
									qos,
								};
								sendPacket(generate(packetData, mqttOptions), packetMethodName(packetData), generalTopic);
							} else {
								// A QoS 0 PUBLISH carries no message identifier, so the whole packet depends only on
								// the payload, the topic, and the protocol version (v5 emits a properties field that
								// v3.1.1 omits) — share it across every QoS 0 subscriber that matches on those.
								// The frame also varies on dup/retain/properties, which are fixed below; anything
								// that starts varying them per subscriber (RETAIN propagation, v5 subscription
								// identifiers) has to join the key or subscribers will be served the wrong flags.
								const protocolVersion = mqttOptions.protocolVersion;
								let packet = getSharedFrame(encoding, protocolVersion, topic);
								if (packet === undefined) {
									packet = generate({ cmd: 'publish', topic, payload, qos: 0, dup: false, retain: false }, mqttOptions);
									// only worth retaining once a second subscriber has shown up; caching a packet
									// for a fan-out of one just pins a whole buffer nothing will read
									if (encoding.hits > 0) setSharedFrame(encoding, protocolVersion, topic, packet);
								}
								sendPacket(packet, 'publish', generalTopic);
							}
							// wait if there is back-pressure
							const rawSocket = socket._socket ?? socket;
							if (rawSocket.writableNeedDrain) {
								return new Promise((resolve) => rawSocket.once('drain', resolve));
							}
							return !rawSocket.closed;
						} catch (error) {
							mqttLog.error?.(error);
							session?.disconnect(false);
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
							emitEvent('error', error, socket, subscription, session);
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
					generateAndSendPacket({
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
					generateAndSendPacket({
						// Send a subscription acknowledgment
						cmd: 'unsuback',
						granted,
						messageId: packet.messageId,
					});
					break;
				}
				case 'pubrel':
					generateAndSendPacket({
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
						socket.deserialize ||
						(socket.deserialize = getDeserializer(request?.headers.get?.('content-type') as string, false));
					const messageLength = packet.payload?.length || 0;
					const data = messageLength > 0 ? deserialize(packet.payload) : undefined; // zero payload length maps to a delete
					let published;
					try {
						published = await session.publish(packet, data);
					} catch (error) {
						emitEvent('error', error, socket, packet, session);
						mqttLog.warn?.(error);
						if (packet.qos > 0) {
							// A publish to a topic no resource handles is the same miss addSubscription already
							// answers with a specific code; reporting it as "unspecified error" leaves it
							// indistinguishable from an internal failure.
							const publishPacket: any = {
								// Send a publish acknowledgment
								cmd: responseCmd,
								messageId: packet.messageId,
								reasonCode:
									mqttOptions.protocolVersion < 5
										? 0x80 // the only error code in v3.1.1
										: error?.statusCode === 403
											? 0x87 // not authorized
											: error?.statusCode === 404
												? 0x90 // topic name invalid
												: 0x80, // unspecified error
							};
							// Only errors this layer maps to a code of their own are safe to describe: any other
							// failure carries an internal message that a client must not be handed. Both limits
							// are in encoded bytes, so measure and trim the string in bytes too.
							const describable =
								mqttOptions.protocolVersion >= 5 &&
								sendProblemInformation &&
								error?.message &&
								(error.statusCode === 403 || error.statusCode === 404);
							const reasonString = describable
								? Buffer.from(String(error.message), 'utf8').subarray(0, REASON_STRING_LIMIT).toString('utf8')
								: undefined;
							if (
								reasonString &&
								(!maximumPacketSize || maximumPacketSize >= Buffer.byteLength(reasonString) + ACK_PACKET_OVERHEAD)
							)
								publishPacket.properties = { reasonString };
							generateAndSendPacket(publishPacket, packet.topic);
						}
						break;
					}
					if (packet.qos > 0) {
						generateAndSendPacket(
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
					generateAndSendPacket({
						// Send a publish response
						cmd: 'pubrel',
						messageId: packet.messageId,
						reasonCode: 0,
					});
					break;
				case 'pubcomp':
				case 'puback':
					await session.acknowledge(packet.messageId);
					emitEvent('acknowledged', session, packet);
					break;
				case 'pingreq':
					generateAndSendPacket({ cmd: 'pingresp' });
					break;
				case 'disconnect':
					disconnected = true;
					session?.disconnect(true);
					emitEvent('disconnected', session, socket);
					mqttSettings.sessions.delete(session);
					recordActionBinary(true, 'connection', 'mqtt', 'disconnect');
					mqttLog.debug?.('Received disconnect command, closing MQTT session', socket.remoteAddress);
					if (socket.close) socket.close();
					else socket.end();
					break;
			}
		} catch (error) {
			emitEvent('error', error, socket, packet, session);
			mqttLog.error?.(error);
			generateAndSendPacket({
				// Send a subscription acknowledgment
				cmd: 'disconnect',
			});
		}
		// analytics stay per subscriber even when the packet itself is shared across them
		function sendPacket(packet, methodName, path?) {
			send(packet);
			recordAction(packet.length, 'bytes-sent', path, methodName, 'mqtt');
		}
		function generateAndSendPacket(packetData, path?) {
			sendPacket(generate(packetData, mqttOptions), packetMethodName(packetData), path);
		}
		function packetMethodName(packet) {
			return packet.qos > 0 ? packet.cmd + ',qos=' + packet.qos : packet.cmd;
		}
	});
	parser.on('error', (error) => {
		mqttLog.warn('MQTT parsing error, closing connection:', error.message);
		if (socket?.destroy) socket.destroy();
		else socket?.terminate();
	});
	return { onMessage, onClose };
}
