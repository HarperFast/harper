// for now we are using mqtt-packet, but we may implement some of this ourselves, particularly packet generation so that
// we can implement more efficient progressive buffer allocation.
import _mqtt_packet from 'mqtt-packet';
const { parser: makeParser, generate } = _mqtt_packet;
import {
	getSession,
	DurableSubscriptionsSession,
	RECEIVE_MAXIMUM,
	SERIALIZING,
} from './DurableSubscriptionsSession.ts';
import { getTrackedUser, localPrincipal, type UserProvenance } from '../security/user.ts';
import { getDeserializer } from './serverHelpers/contentTypes.ts';
import {
	getSharedMessageEncoding,
	getSharedFrame,
	setSharedFrame,
	resolveSharedPayload,
} from './serverHelpers/sharedMessageEncoding.ts';
import { recordAction, addAnalyticsListener, recordActionBinary } from '../resources/analytics/write.ts';
import { get } from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS, AUTH_AUDIT_STATUS, AUTH_AUDIT_TYPES } from '../utility/hdbTerms.ts';
import { loggerWithTag } from '../utility/logging/logger.ts';
import { forComponent as loggerForComponent } from '../utility/logging/harper_logger.ts';
import { EventEmitter } from 'node:events';
import { verifyCertificate } from '../security/certificateVerification/index.ts';
import { registerShutdownDrain } from '../components/shutdownDrain.ts';
import { onStartup } from '../utility/lifecycle.ts';
import { toCloseReason } from './serverHelpers/webSocketCloseReason.ts';
import { isLocalPeerAddress } from './serverHelpers/peerAddress.ts';
import { isBun } from './serverHelpers/Request.ts';
import { DatabaseGenerationChangedError, ResumeHistoryUnavailableError } from '../utility/errors/hdbError.ts';
import {
	assertNoDeferredCredentialRejection,
	getAuthenticationRejectedInPlace,
	getDeferredCredentialRejection,
} from '../security/deferredAuthentication.ts';

/** RFC 6455 private-use close code Harper already maps HTTP 401 to (see server/REST.ts). */
const WEBSOCKET_UNAUTHORIZED_CLOSE_CODE = 3000;
const authEventLog = loggerWithTag('auth-event');
const mqttLog = loggerForComponent('mqtt');

let AUTHORIZE_LOCAL = get(CONFIG_PARAMS.AUTHENTICATION_AUTHORIZELOCAL) ?? process.env.DEV_MODE;
/** Multiplied by the QoS and added to the protocol version, the frame-cache key of a QoS 1/2 PUBLISH template. */
const QOS_TEMPLATE_KEY = 0x100;
/** Where a QoS 1/2 PUBLISH's packet identifier sits: after the fixed header and the length-prefixed topic. */
function packetIdOffset(packet: Buffer): number {
	let offset = 1;
	while (packet[offset++] & 0x80); // the remaining-length varint
	return offset + 2 + packet.readUInt16BE(offset);
}
/** The first byte of each acknowledgement packet (PUBREL's carries its required flags), by its name. */
const ACKNOWLEDGEMENT_COMMANDS = { 0x40: 'puback', 0x50: 'pubrec', 0x62: 'pubrel', 0x70: 'pubcomp' };
/**
 * Whether data is nothing but whole acknowledgements (PUBACK, PUBREC, PUBREL, PUBCOMP) of the 4-byte form
 * every protocol version shares: success, with no reason code or properties.
 */
function onlyAcknowledgements(data: any): boolean {
	const length = data?.length;
	if (!(length > 0) || length % 4 !== 0 || !Buffer.isBuffer(data)) return false;
	for (let offset = 0; offset < length; offset += 4) {
		if (ACKNOWLEDGEMENT_COMMANDS[data[offset]] === undefined || data[offset + 1] !== 2) return false;
	}
	return true;
}
/** The packet mqtt-packet's parser emits for a 4-byte acknowledgement; only v5 gives it a reason code. */
function acknowledgementPacket(firstByte: number, messageId: number, protocolVersion: number) {
	const packet: any = {
		cmd: ACKNOWLEDGEMENT_COMMANDS[firstByte],
		retain: false,
		qos: (firstByte >> 1) & 3,
		dup: false,
		length: 2,
		topic: null,
		payload: null,
		messageId,
	};
	if (protocolVersion === 5) packet.reasonCode = 0;
	return packet;
}

onStartup(() => {
	AUTHORIZE_LOCAL = get(CONFIG_PARAMS.AUTHENTICATION_AUTHORIZELOCAL) ?? process.env.DEV_MODE;
});
/** Test mode: trust loopback connections. Returns a function that restores the previous setting. */
export function bypassAuth(): () => void {
	const previous = AUTHORIZE_LOCAL;
	AUTHORIZE_LOCAL = true;
	return () => {
		AUTHORIZE_LOCAL = previous;
	};
}

const authorizeLocal = (remoteAddress: string) => AUTHORIZE_LOCAL && isLocalPeerAddress(remoteAddress);

// shared by every connection, rather than a closure each connection keeps
function logWebSocketError(error) {
	mqttLog.info?.('WebSocket error', error);
}
function logSocketError(error) {
	mqttLog.info?.('Socket error', error);
}

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
					// read the records rather than the error: both hold a client-safe message, while an
					// arbitrary chain rejection landing here would not
					const rejection = getDeferredCredentialRejection(request) ?? getAuthenticationRejectedInPlace(request);
					ws.close(WEBSOCKET_UNAUTHORIZED_CLOSE_CODE, toCloseReason(rejection?.message ?? 'Unauthorized'));
				});
				const sendFrame = (message) => {
					ws.send(message);
				};
				// held only on a Node socket: uWS's shim has no cork, and Bun's is unverified
				const rawSocket = ws._socket;
				const send = !isBun && typeof rawSocket?.cork === 'function' ? holdingWriter(rawSocket, sendFrame) : sendFrame;
				const { onMessage, onClose } = onSocket(ws, send, request, authenticated, mqttSettings);
				ws.on('message', onMessage);
				ws.on('close', onClose);
				ws.on('error', logWebSocketError);
			},
			{ ...webSocket, after: 'authentication' }
		); // if there is no port, we are piggy-backing off of default app http server
	// standard TCP socket
	if (port || securePort) {
		serverInstances.push(
			server.socket(
				async (socket) => {
					let user;
					const admission: { provenance?: UserProvenance } = {};
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
										user = await getTrackedUser(username, null, null, admission, server);
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
						user = localPrincipal();
						mqttLog.debug?.('Auto-authorizing local connection');
					}

					const write = (message) => socket.write(message);
					const send = typeof socket.cork === 'function' ? holdingWriter(socket, write) : write;
					const { onMessage, onClose } = onSocket(socket, send, null, user, mqttSettings, admission.provenance);
					socket.on('data', onMessage);
					socket.on('close', onClose);
					socket.on('error', logSocketError);
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
/** `AccessViolation` is 401 for a request with no user and 403 for a user lacking permission; an MQTT client sees both as "Not authorized". */
const isNotAuthorized = (error: any) => error?.statusCode === 401 || error?.statusCode === 403;
/** mqtt-packet writes `reasonCode` to a v5 client and `returnCode` to a 3.1/3.1.1 client, so a refusal carries both. */
const CONNACK_REFUSALS = {
	badCredentials: { reasonCode: 0x86, returnCode: 4 },
	notAuthorized: { reasonCode: 0x87, returnCode: 5 },
	unspecified: { reasonCode: 0x80, returnCode: 3 }, // 3.1.1 has no generic refusal; "server unavailable" is closest
};
const V5_CONNACK_REFUSAL_CODES = new Set([
	0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8c, 0x90, 0x95, 0x97, 0x99, 0x9a, 0x9b, 0x9c,
	0x9d, 0x9f,
]);
/** The code goes into one byte: an HTTP status written raw would wrap into an unrelated code. */
function connackRefusalFor(error: any, protocolVersion: number | undefined, fallback = CONNACK_REFUSALS.unspecified) {
	const { code } = error ?? {};
	const allowed =
		protocolVersion === 5 ? V5_CONNACK_REFUSAL_CODES.has(code) : Number.isInteger(code) && code >= 1 && code <= 5;
	if (allowed) return { reasonCode: code, returnCode: code };
	if (isNotAuthorized(error) || code === 401 || code === 403) return CONNACK_REFUSALS.notAuthorized;
	return fallback;
}
/** Only failures this layer maps to a code of their own are safe to describe: any other carries an internal message. */
const hasClientSafeMessage = (error: any) => isNotAuthorized(error) || error?.statusCode === 404;
/** REASON_STRING_LIMIT counts encoded bytes, and a character must not be cut in half. */
function boundedReasonString(message: unknown): string {
	const text = String(message);
	if (Buffer.byteLength(text) <= REASON_STRING_LIMIT) return text;
	const bytes = Buffer.from(text, 'utf8');
	let end = REASON_STRING_LIMIT;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString('utf8');
}

/**
 * Every live MQTT connection on this worker, so a shutdown can announce itself: a bare socket close
 * is indistinguishable to the client from a network failure.
 */
const liveConnections = new Set<{ mqttOptions: { protocolVersion: number }; send: (data: any) => void; socket: any }>();
/** Settles once every CONNECT so far for each client id on this thread has finished or given up its turn. */
const connecting = new Map<string, Promise<void>>();
/**
 * Each client id's sessions on this thread, kept until their last save settles so a takeover can wait for it: the
 * session itself while it is the only one, as it is for nearly every client, and a set only while connections overlap.
 */
const clientSessions = new Map<string, DurableSubscriptionsSession | Set<DurableSubscriptionsSession>>();
let takeoverTimeout = 10_000;

export function setTakeoverTimeoutForTests(milliseconds: number): number {
	const previous = takeoverTimeout;
	takeoverTimeout = milliseconds;
	return previous;
}

function clientSessionsOf(clientId: string): DurableSubscriptionsSession[] {
	const held = clientSessions.get(clientId);
	return held === undefined ? [] : held instanceof Set ? [...held] : [held];
}

function addClientSession(session: DurableSubscriptionsSession) {
	const clientId = session.sessionId;
	if (!clientId) return;
	const held = clientSessions.get(clientId);
	if (held === undefined) clientSessions.set(clientId, session);
	else if (held instanceof Set) held.add(session);
	else if (held !== session) clientSessions.set(clientId, new Set([held, session]));
}

function holdsClientSession(session: DurableSubscriptionsSession): boolean {
	if (!session) return false;
	const held = clientSessions.get(session.sessionId);
	return held === session || (held instanceof Set && held.has(session));
}

function releaseClientSession(session: DurableSubscriptionsSession) {
	if (!holdsClientSession(session)) return;
	const writes = session.writes;
	Promise.resolve(writes).then(() => {
		if (session.writes !== writes) return releaseClientSession(session);
		const held = clientSessions.get(session.sessionId);
		if (held === session) clientSessions.delete(session.sessionId);
		else if (held instanceof Set && held.delete(session) && held.size === 0) clientSessions.delete(session.sessionId);
	});
}

function beforeDeadline<T>(promise: Promise<T>, deadline: number, protocolVersion: number): Promise<T> {
	let timer: NodeJS.Timeout;
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => {
					const error: any = new Error('An earlier connection for this client id did not finish in time');
					error.code = protocolVersion >= 5 ? 0x88 : 0x03; // server unavailable
					reject(error);
				},
				Math.max(0, deadline - Date.now())
			);
			timer.unref?.();
		}),
	]).finally(() => clearTimeout(timer));
}
let shutdownDisconnectRegistered = false;

/** v3.1.1 has no server-to-client DISCONNECT, so those connections are only closed. */
export function disconnectClientsForShutdown() {
	if (liveConnections.size === 0) return;
	const disconnectPacket = generate({ cmd: 'disconnect', reasonCode: SERVER_SHUTTING_DOWN } as any, {
		protocolVersion: 5,
	});
	for (const connection of liveConnections) {
		try {
			if (connection.mqttOptions.protocolVersion >= 5) connection.send(disconnectPacket);
		} catch (error) {
			mqttLog.debug?.('Could not notify MQTT connection of shutdown', error);
		} finally {
			try {
				closeSocket(connection.socket);
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

/**
 * mqtt-packet's parser buffers a packet's bytes in a stream of its own and is stateless between packets, so the
 * parsers here serve every connection on this thread that is between packets. A connection holds one of its own
 * while a packet it began is incomplete, and while it streams packets across reads: it gives the parser back
 * once two reads in a row end between packets, so a quiet client holds none, and one whose packets straddle
 * reads does not take a parser for each.
 */
const idleParsers: any[] = [];
const MAX_IDLE_PARSERS = 64;
function newParser() {
	const parser: any = makeParser({ protocolVersion: 5 });
	parser.target = null;
	// the socket of the connection parsing with it, which a parse error closes
	parser.socket = null;
	parser.on('packet', (packet) => parser.target(packet));
	parser.on('error', (error) => parseFailed(parser.socket, error));
	return parser;
}
/** What mqtt-packet's parser reads its settings for: the protocol version, and whether a client is a bridge. */
const PARSER_SETTINGS = {
	3: Object.freeze({ protocolVersion: 3 }),
	4: Object.freeze({ protocolVersion: 4 }),
	5: Object.freeze({ protocolVersion: 5 }),
};
/** A CONNECT becomes the parser's settings: what the next packets parse by is kept, not the packet itself. */
function parserSettingsFor(settings: any) {
	if (!settings.bridgeMode && PARSER_SETTINGS[settings.protocolVersion] === settings) return settings;
	if (settings.bridgeMode) return { protocolVersion: settings.protocolVersion, bridgeMode: true };
	return PARSER_SETTINGS[settings.protocolVersion] ?? { protocolVersion: settings.protocolVersion };
}

/**
 * A writer that can hold a run of packets for one writev on `socket`, the TCP socket that `write` sends on
 * (directly, or as WebSocket frames). The session holds its sends while one of its deliveries sends more than one
 * message (the drain in DurableSubscriptionsSession.ts) and releases them when that turn ends, so a burst to one
 * client costs a write syscall per turn, not per packet, and no other client's work runs between a packet and its
 * write. The `ws` library corks around each frame's header and payload; that nests inside this hold. Past
 * MAX_HELD_BYTES what is held goes out at once, keeping it far below the socket's high-water mark, so
 * `writableNeedDrain`, which the delivery path waits on, still means the kernel is not taking what was written.
 */
const MAX_HELD_BYTES = 4096;
function holdingWriter(socket, send: (packet: Buffer) => void) {
	let holding = false;
	const write = (packet: Buffer) => {
		if (holding && socket.writableLength + packet.length > MAX_HELD_BYTES) {
			socket.uncork();
			socket.cork();
		}
		send(packet);
	};
	write.hold = () => {
		if (holding) return;
		holding = true;
		socket.cork();
	};
	write.release = () => {
		if (!holding) return;
		holding = false;
		socket.uncork();
	};
	return write;
}

/** Analytics stay per subscriber even when the packet itself is shared across them. */
function sendPacket(send: (packet: Buffer) => void, packet: Buffer, methodName: string, path?: string) {
	send(packet);
	recordAction(packet.length, 'bytes-sent', path, methodName, 'mqtt');
}
function packetMethodName(packet) {
	return packet.qos > 0 ? packet.cmd + ',qos=' + packet.qos : packet.cmd;
}
function emitMqttEvent(mqttSettings, type: string, ...args: any[]) {
	try {
		mqttSettings.events.emit(type, ...args);
	} catch (error) {
		mqttLog.warn?.(`Error emitting MQTT event '${type}':`, error);
	}
}
function closeSocket(socket) {
	return socket.close ? socket.close() : socket.end();
}
function parseFailed(socket, error) {
	mqttLog.warn?.('MQTT parsing error, closing connection:', error.message);
	if (socket?.destroy) socket.destroy();
	else socket?.terminate();
}
function releaseParser(reading) {
	reading.target = reading.socket = null;
	if (idleParsers.length < MAX_IDLE_PARSERS) idleParsers.push(reading);
}

let addingMetrics,
	numberOfConnections = 0;
function onSocket(socket, send, request, user, mqttSettings, userProvenance?: UserProvenance) {
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
	// What a connection keeps lives in this scope for as long as it is open, so helpers that need nothing of it are
	// module functions, and what only some connections need (a stall timer's callback) is built when they do.
	let disconnected;
	// set by a failed delivery, so sibling subscriptions stop writing before the aborted socket's 'close' arrives
	let aborted = false;
	numberOfConnections++;
	const mqttOptions = { protocolVersion: 4 };
	const connection = { mqttOptions, send, socket };
	liveConnections.add(connection);
	let session: DurableSubscriptionsSession;
	function closeConnection(error?: Error) {
		try {
			if (mqttOptions.protocolVersion >= 5) {
				const packet: any = {
					cmd: 'disconnect',
					reasonCode: error ? ((error as any).mqttReasonCode ?? (isNotAuthorized(error) ? 0x87 : 0x83)) : 0x8e,
				};
				// as for PUBACK: only failures this layer describes itself are safe to hand a client
				const describable =
					error instanceof DatabaseGenerationChangedError ||
					error instanceof ResumeHistoryUnavailableError ||
					hasClientSafeMessage(error);
				const reasonString =
					describable && error.message && sendProblemInformation ? boundedReasonString(error.message) : undefined;
				if (
					reasonString &&
					(!maximumPacketSize || maximumPacketSize >= Buffer.byteLength(reasonString) + ACK_PACKET_OVERHEAD)
				)
					packet.properties = { reasonString };
				send(generate(packet, mqttOptions));
			}
		} catch (sendError) {
			mqttLog.warn?.('Could not send DISCONNECT before closing the connection', sendError);
		} finally {
			closeSocket(socket);
		}
	}
	// [MQTT-3.1.2-29]: a client that asks for no problem information must not be sent a reason
	// string on a PUBACK/PUBREC, and [MQTT-3.1.2-24] caps what it will accept at all.
	let sendProblemInformation = true;
	let maximumPacketSize: number | undefined;
	let parser: any;
	let midPacket = false;
	let lastReadStraddled = false;
	let parserSettings = PARSER_SETTINGS[5];
	function onMessage(data) {
		if (!midPacket && onlyAcknowledgements(data)) {
			// a second read in a row that ends between packets: a parser kept for a stream goes back
			if (parser) {
				releaseParser(parser);
				parser = undefined;
			}
			for (let offset = 0; offset < data.length; offset += 4) {
				handlePacket(acknowledgementPacket(data[offset], data.readUInt16BE(offset + 2), mqttOptions.protocolVersion));
			}
			return;
		}
		// taken out of the idle ones while it parses, since a packet it emits can lead, in the same turn, to data
		// for another connection
		let reading = parser;
		if (!reading) {
			reading = idleParsers.pop() ?? newParser();
			reading.target = handlePacket;
			reading.socket = socket;
			reading.settings = parserSettings;
		}
		let remaining: number;
		try {
			remaining = reading.parse(data);
		} finally {
			// parsing a CONNECT makes its packet, credentials included, the parser's settings: what the next packets
			// parse by is kept instead
			if (reading.settings !== parserSettings) reading.settings = parserSettings = parserSettingsFor(reading.settings);
		}
		// The parser consumes a packet's fixed header before its body arrives, so holding no bytes does not
		// mean it is between packets; its state counter returns to 0 only once a packet is complete.
		midPacket = !(remaining === 0 && reading._stateCounter === 0 && !reading.error);
		if (midPacket || lastReadStraddled) parser = reading;
		else {
			releaseParser(reading);
			parser = undefined;
		}
		lastReadStraddled = midPacket;
	}
	function onClose() {
		numberOfConnections--;
		liveConnections.delete(connection);
		if (!disconnected) {
			disconnected = true;
			session?.disconnect?.(false);
			emitMqttEvent(mqttSettings, 'disconnected', session, socket);
			mqttSettings.sessions.delete(session);
			releaseClientSession(session);
			recordActionBinary(false, 'connection', 'mqtt', 'disconnect');
			mqttLog.debug?.('MQTT connection was closed', socket.remoteAddress);
		}
	}

	// The delivery path is built here rather than where the CONNECT installs it, so what a connection keeps for its
	// deliveries is this scope, not that packet's handling: the CONNECT packet (its credentials included) and the
	// helpers of that call would otherwise live as long as the connection.
	// A failed delivery aborts the connection: ending only the session would leave the client connected
	// and receiving nothing. An abort, unlike a graceful end, closes without waiting on the peer, and
	// onClose ends the session.
	const failDelivery = (error) => {
		mqttLog.error?.(error);
		aborted = true;
		// what this turn sent before the failed delivery goes out, as it would had it not been held
		send.release?.();
		if (socket.destroy) socket.destroy();
		else socket.terminate();
		return false;
	};
	// consecutive messages under one topic string (a record's, or one fan-out's) share its first
	// level, so it is sliced out once rather than per message
	let lastTopic: string;
	let lastGeneralTopic: string;
	// returns a promise only on socket back-pressure, so a delivery costs the session no microtask
	const deliver = (topic, payload, encoding, messageId, subscription, dup) => {
		try {
			if (topic !== lastTopic) {
				const slashIndex = topic.indexOf('/', 1);
				lastGeneralTopic = slashIndex > 0 ? topic.slice(0, slashIndex) : topic;
				lastTopic = topic;
			}
			const generalTopic = lastGeneralTopic;
			const qos = subscription.qos || 0;
			if (qos > 0 && messageId && !dup) {
				// A QoS 1/2 PUBLISH differs between its subscribers only in the packet identifier, so
				// one generated frame serves as the template and each subscriber gets a copy with its
				// own identifier written in, rather than re-encoding the payload into a new packet.
				// Templates share the frame cache under a key apart from the protocol versions QoS 0
				// frames use. A resend (dup) is generated on its own.
				const key = QOS_TEMPLATE_KEY * qos + mqttOptions.protocolVersion;
				const template = getSharedFrame(encoding, key, topic);
				let packet: Buffer;
				if (template === undefined) {
					packet = generate({ cmd: 'publish', topic, payload, messageId, qos, dup: false, retain: false }, mqttOptions);
					if (encoding.hits > 0) setSharedFrame(encoding, key, topic, packet);
				} else {
					packet = Buffer.allocUnsafe(template.length);
					template.copy(packet);
					packet.writeUInt16BE(messageId, packetIdOffset(template));
				}
				sendPacket(send, packet, qos === 1 ? 'publish,qos=1' : 'publish,qos=' + qos, generalTopic);
			} else if (qos > 0) {
				// mqtt-packet requires a numeric message identifier once qos is non-zero
				const packetData: any = {
					cmd: 'publish',
					topic,
					payload,
					messageId: messageId || Math.floor(Math.random() * 100000000),
					qos,
					dup,
				};
				sendPacket(send, generate(packetData, mqttOptions), packetMethodName(packetData), generalTopic);
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
				sendPacket(send, packet, 'publish', generalTopic);
			}
			// wait if there is back-pressure
			const rawSocket = socket._socket ?? socket;
			if (rawSocket.writableNeedDrain) {
				return new Promise((resolve) => rawSocket.once('drain', resolve));
			}
			return !rawSocket.closed;
		} catch (error) {
			return failDelivery(error);
		}
	};
	const listener = (topic, message, messageId, subscription, version, dup) => {
		try {
			if (disconnected || aborted) {
				// a delivery already past the subscription when the client left or a failed delivery aborted
				// the connection; onClose ends the session
				mqttLog.debug?.(
					`Session ${session?.sessionId} ${aborted ? 'aborted' : 'disconnected'} while trying to send message to ${topic}`
				);
				return false;
			}
			// Every subscriber of a topic serializes the same message to the same bytes, so the
			// payload is encoded once per (message, content type) and reused across all of them.
			const encoding = getSharedMessageEncoding(message, request, version);
			const encoded = encoding.payload;
			// only pay for a promise when the serialization is genuinely still pending
			if (typeof (encoded as any)?.then === 'function') {
				const serialized: any = resolveSharedPayload(encoding, message, request, version).then(
					(payload) =>
						disconnected || aborted ? false : deliver(topic, payload, encoding, messageId, subscription, dup),
					failDelivery
				);
				serialized[SERIALIZING] = true;
				return serialized;
			}
			return deliver(topic, encoded as Buffer | string, encoding, messageId, subscription, dup);
		} catch (error) {
			return failDelivery(error);
		}
	};

	const handlePacket = async (packet: any) => {
		try {
			if (user?.then) user = await user;
		} catch (error) {
			socket.close?.(1008, 'Unauthorized');
			mqttLog.info?.(error); // should already be handled elsewhere
			return;
		}
		const command = packet.cmd;
		if (session) {
			if ((session as any).then) {
				try {
					await session;
				} catch {
					return; // the CONNECT has answered its own failure
				}
				if (!session) return; // the client left before its CONNECT finished
			}
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
							const admission: { provenance?: UserProvenance } = {};
							user = await getTrackedUser(packet.username, packet.password.toString(), request, admission);
							userProvenance = admission.provenance;
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
							emitMqttEvent(mqttSettings, 'auth-failed', packet, socket, error);
							recordActionBinary(false, 'connection', 'mqtt', 'connect');
							return generateAndSendPacket({
								// Send a connection acknowledgment with indication of auth failure
								cmd: 'connack',
								...CONNACK_REFUSALS.badCredentials,
							});
						}
					}
					if (!user && mqttSettings.requireAuthentication) {
						emitMqttEvent(mqttSettings, 'auth-failed', packet, socket);
						recordActionBinary(false, 'connection', 'mqtt', 'connect');
						return generateAndSendPacket({
							// Send a connection acknowledgment with indication of auth failure
							cmd: 'connack',
							...CONNACK_REFUSALS.badCredentials,
						});
					}
					const refuseConnect = (error, fallback?) => {
						mqttLog.error?.(error);
						emitMqttEvent(mqttSettings, 'auth-failed', packet, socket, error);
						recordActionBinary(false, 'connection', 'mqtt', 'connect');
						return generateAndSendPacket({
							// Send a connection acknowledgment with indication of auth failure
							cmd: 'connack',
							...connackRefusalFor(error, packet.protocolVersion, fallback),
						});
					};
					try {
						// TODO: Do we want to prefix the user name to the client id (to prevent collisions when poor ids are used) or is this sufficient?
						try {
							mqttSettings.authorizeClient?.(packet, user);
						} catch (error) {
							// a hook refuses by throwing, and a bare Error is a denial, not a server fault
							return refuseConnect(error, CONNACK_REFUSALS.notAuthorized);
						}

						// TODO: Handle the will & testament, and possibly use the will's content type as a hint for expected content
						if (packet.will) {
							const deserialize =
								socket.deserialize ||
								(socket.deserialize = getDeserializer(request?.headers.get?.('content-type') as string, false));
							(packet.will as any).data =
								packet.will.payload?.length > 0 ? deserialize(packet.will.payload) : undefined;
							delete packet.will.payload;
						}
						const clientId = packet.clientId;
						let releaseClaim: (() => void) | undefined;
						try {
							// assigned before any wait, so packets sent right behind the CONNECT wait for it too
							session = (async () => {
								if (clientId) {
									// simultaneous CONNECTs for one client id take the session over in turn
									const previous = connecting.get(clientId);
									const own = new Promise<void>((resolve) => (releaseClaim = resolve));
									// one that gives up waiting keeps its place until the CONNECT before it finishes
									const turn = previous ? Promise.all([previous, own]).then(() => {}) : own;
									connecting.set(clientId, turn);
									turn.then(() => {
										if (connecting.get(clientId) === turn) connecting.delete(clientId);
									});
									const deadline = Date.now() + takeoverTimeout;
									if (previous) await beforeDeadline(previous, deadline, packet.protocolVersion);
									// a client that left while it waited takes nothing over
									if (disconnected) return;
									// a durable session has one owner: an older connection for this client on this thread gives
									// way, to a clean start too, and its last save lands before this one reads or deletes
									const older = clientSessionsOf(clientId);
									for (const other of older) other.yieldTo?.();
									if (older.length > 0) {
										await beforeDeadline(
											Promise.all(older.map((other) => other.writes)),
											deadline,
											packet.protocolVersion
										);
										if (disconnected) return;
									}
								}
								return getSession({
									user,
									...packet,
								} as any);
							})() as any;
							session = await session;
							if (!session) return;
							session.closeConnection = closeConnection;
							session.userProvenance = userProvenance;
							if (send.hold) {
								session.holdSends = send.hold;
								session.releaseSends = send.release;
							}
							// the session is used in the context, and we want to make sure we can access this
							session.socket = socket;
							if (request) {
								// if there a request, store it in the session so we can use it as part of the context
								session.request = request;
							}
							mqttSettings.sessions.add(session);
							addClientSession(session);
							if (disconnected) {
								// the client left while this CONNECT waited, and nothing else will end its session
								session.disconnect(false);
								mqttSettings.sessions.delete(session);
								releaseClientSession(session);
								return;
							}
						} finally {
							releaseClaim?.();
						}
					} catch (error) {
						return refuseConnect(error);
					}
					emitMqttEvent(mqttSettings, 'connected', session, socket);
					recordActionBinary(true, 'connection', 'mqtt', 'connect');
					generateAndSendPacket({
						// Send a connection acknowledgment
						cmd: 'connack',
						sessionPresent: session.sessionWasPresent,
						reasonCode: 0,
						returnCode: 0, // success
						properties: { receiveMaximum: RECEIVE_MAXIMUM },
					});
					session.setListener(listener);
					if (session.sessionWasPresent) {
						// [MQTT-4.4.0-1] a PUBREL the client never completed is sent again before anything new
						for (const messageId of session.awaitingCompletion?.keys() ?? [])
							generateAndSendPacket({ cmd: 'pubrel', messageId, reasonCode: 0 });
						await session.resume();
					}
					break;
				case 'subscribe':
					const granted = [];
					// a SUBACK carries one reason string for the whole packet, so the first refusal's is the one sent
					let refusalMessage: string | undefined;
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
							emitMqttEvent(mqttSettings, 'error', error, socket, subscription, session);
							if (error.statusCode) {
								if (error.statusCode === 500) mqttLog.warn?.(error);
								else mqttLog.info?.(error);
							} else mqttLog.error?.(error);
							grantedQos =
								mqttOptions.protocolVersion < 5
									? 0x80 // the only error code in v3.1.1
									: isNotAuthorized(error)
										? 0x87 // unauthorized
										: error.statusCode === 404
											? 0x8f // invalid topic
											: 0x80; // generic failure
							if (mqttOptions.protocolVersion >= 5 && error.message && hasClientSafeMessage(error))
								refusalMessage ??= error.message;
						}
						granted.push(grantedQos);
					}
					await session.committed;
					const subackPacket: any = { cmd: 'suback', granted, messageId: packet.messageId };
					if (refusalMessage !== undefined && sendProblemInformation)
						subackPacket.properties = { reasonString: boundedReasonString(refusalMessage) };
					let suback = generate(subackPacket, mqttOptions);
					// the result vector grows with the filter count, so only the encoded packet says whether the string fits
					if (subackPacket.properties && maximumPacketSize && suback.length > maximumPacketSize) {
						delete subackPacket.properties;
						suback = generate(subackPacket, mqttOptions);
					}
					sendPacket(send, suback, 'suback');
					break;
				case 'unsubscribe': {
					const granted = [];
					for (const subscription of packet.unsubscriptions) {
						try {
							granted.push((await session.removeSubscription(subscription)) ? 0 : 0x11); // no subscription existed
						} catch (error) {
							if (error?.statusCode < 500) mqttLog.info?.(error);
							else mqttLog.warn?.(error);
							granted.push(0x80); // unspecified error
						}
					}
					generateAndSendPacket({
						// Send a subscription acknowledgment
						cmd: 'unsuback',
						granted,
						messageId: packet.messageId,
					});
					break;
				}
				case 'pubrel': {
					const released = await session.release(packet.messageId);
					generateAndSendPacket({
						cmd: 'pubcomp',
						messageId: packet.messageId,
						reasonCode: released ? 0 : 0x92, // packet identifier not found
					});
					return;
				}
				case 'publish': {
					const acknowledgement =
						packet.qos === 2
							? await session.receiveExactlyOnce(packet.messageId, () => publish(packet))
							: await publish(packet);
					if (acknowledgement) generateAndSendPacket(acknowledgement, packet.topic);
					break;
				}
				case 'pubrec': {
					const failed = packet.reasonCode >= 0x80;
					const known = await session.received(packet.messageId, failed);
					if (failed) break;
					if (known) {
						// a successful PUBREL is the same four bytes in every protocol version
						const pubrel = Buffer.allocUnsafe(4);
						pubrel[0] = 0x62;
						pubrel[1] = 2;
						pubrel.writeUInt16BE(packet.messageId, 2);
						sendPacket(send, pubrel, 'pubrel');
					} else generateAndSendPacket({ cmd: 'pubrel', messageId: packet.messageId, reasonCode: 0x92 }); // packet identifier not found
					break;
				}
				case 'pubcomp':
					await session.completed(packet.messageId);
					emitMqttEvent(mqttSettings, 'acknowledged', session, packet);
					break;
				case 'puback':
					await session.acknowledge(packet.messageId);
					emitMqttEvent(mqttSettings, 'acknowledged', session, packet);
					break;
				case 'pingreq':
					generateAndSendPacket({ cmd: 'pingresp' });
					break;
				case 'disconnect':
					disconnected = true;
					session?.disconnect(true);
					emitMqttEvent(mqttSettings, 'disconnected', session, socket);
					mqttSettings.sessions.delete(session);
					releaseClientSession(session);
					recordActionBinary(true, 'connection', 'mqtt', 'disconnect');
					mqttLog.debug?.('Received disconnect command, closing MQTT session', socket.remoteAddress);
					if (socket.close) socket.close();
					else socket.end();
					break;
			}
		} catch (error) {
			emitMqttEvent(mqttSettings, 'error', error, socket, packet, session);
			mqttLog.error?.(error);
			if (error?.mqttReasonCode) closeConnection(error);
			else
				generateAndSendPacket({
					// Send a subscription acknowledgment
					cmd: 'disconnect',
				});
		}
		function generateAndSendPacket(packetData, path?) {
			sendPacket(send, generate(packetData, mqttOptions), packetMethodName(packetData), path);
		}
		async function publish(packet) {
			const responseCmd = packet.qos === 2 ? 'pubrec' : 'puback';
			const deserialize =
				socket.deserialize ||
				(socket.deserialize = getDeserializer(request?.headers.get?.('content-type') as string, false));
			const messageLength = packet.payload?.length || 0;
			const data = messageLength > 0 ? deserialize(packet.payload) : undefined; // zero payload length maps to a delete
			let published;
			try {
				published = await session.publish(packet, data);
			} catch (error) {
				emitMqttEvent(mqttSettings, 'error', error, socket, packet, session);
				mqttLog.warn?.(error);
				if (!(packet.qos > 0)) return;
				// A publish to a topic no resource handles is the same miss addSubscription already
				// answers with a specific code; reporting it as "unspecified error" leaves it
				// indistinguishable from an internal failure.
				const acknowledgement: any = {
					cmd: responseCmd,
					messageId: packet.messageId,
					reasonCode:
						mqttOptions.protocolVersion < 5
							? 0x80 // the only error code in v3.1.1
							: isNotAuthorized(error)
								? 0x87 // not authorized
								: error?.statusCode === 404
									? 0x90 // topic name invalid
									: 0x80, // unspecified error
				};
				const describable =
					mqttOptions.protocolVersion >= 5 && sendProblemInformation && error?.message && hasClientSafeMessage(error);
				const reasonString = describable ? boundedReasonString(error.message) : undefined;
				if (
					reasonString &&
					(!maximumPacketSize || maximumPacketSize >= Buffer.byteLength(reasonString) + ACK_PACKET_OVERHEAD)
				)
					acknowledgement.properties = { reasonString };
				return acknowledgement;
			}
			if (packet.qos > 0)
				return {
					cmd: responseCmd,
					messageId: packet.messageId,
					reasonCode:
						published === false
							? 0x90 // Topic name invalid
							: 0, //success
				};
		}
	};
	return { onMessage, onClose };
}
