/**
 * mqtt.ts parses every connection that is between packets with one idle parser per thread, and a connection
 * keeps a parser of its own only while a packet it began is incomplete: a parser buffers in a stream, which every
 * idle connection used to hold. A packet split across reads, interleaved with other
 * connections' packets of another protocol version, must still parse as its own.
 */
const assert = require('node:assert');
const v8 = require('node:v8');
const { EventEmitter } = require('node:events');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { handleApplication } = require('#src/server/mqtt');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const mqttPacket = require('mqtt-packet');
const Parser = require('mqtt-packet/parser');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const user = { username: 'mqtt-parser-test', role: { permission: { super_user: true } } };

function mqttWebSocketListener() {
	let listener;
	const server = {
		ws: (fn) => ((listener = fn), []),
		socket: () => ({}),
		mqtt: { sessions: new Set(), events: new EventEmitter() },
	};
	handleApplication({ options: { getAll: () => ({ webSocket: {} }) }, server });
	return listener;
}

function client(listener, protocolVersion) {
	const rawSocket = new EventEmitter();
	rawSocket.remoteAddress = '127.0.0.1';
	const socket = { handlers: {}, sent: [], _socket: rawSocket, close() {}, terminate() {}, destroy() {} };
	socket.send = (packet) => socket.sent.push(packet);
	socket.on = (event, handler) => (socket.handlers[event] = handler);
	const headers = { 'sec-websocket-protocol': 'mqtt' };
	const request = { headers: { asObject: headers, get: (name) => headers[name.toLowerCase()] }, user };
	listener(socket, request, Promise.resolve({ status: 200 }), () => {});
	return {
		socket,
		encode: (packet) => mqttPacket.generate(packet, { protocolVersion }),
		read: (data) => socket.handlers.message(data),
		received(cmd) {
			const parser = mqttPacket.parser({ protocolVersion });
			const packets = [];
			parser.on('packet', (packet) => packet.cmd === cmd && packets.push(packet));
			for (const sent of socket.sent) parser.parse(sent);
			return packets;
		},
	};
}

describe('MQTT packet parsing across connections', function () {
	this.timeout(20_000);
	let T;
	let name;
	let listener;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
		name = 'ParserSharing';
		T = table({
			table: name,
			database: 'mqtt_parser_sharing',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		Resources.resources.set(name, T, { mqtt: true });
		listener = mqttWebSocketListener();
	});

	it('parses a packet split across reads as its own, while other connections parse theirs in between', async () => {
		const v4 = client(listener, 4);
		const v5 = client(listener, 5);
		v4.read(v4.encode({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clientId: 'split-v4', clean: true }));
		v5.read(v5.encode({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 5, clientId: 'split-v5', clean: true }));
		await waitFor(() => v4.received('connack').length === 1 && v5.received('connack').length === 1);
		// a v4 PUBLISH has no properties, which a parser set for v5 would read its payload as
		const publish = v4.encode({ cmd: 'publish', topic: `${name}/split`, payload: '{"value":4}', qos: 1, messageId: 9 });
		v4.read(publish.subarray(0, 7));
		v5.read(
			v5.encode({
				cmd: 'subscribe',
				messageId: 3,
				subscriptions: [{ topic: `${name}/other`, qos: 0 }],
				properties: { subscriptionIdentifier: 7 },
			})
		);
		v4.read(publish.subarray(7));
		await waitFor(() => v4.received('puback').length === 1 && v5.received('suback').length === 1);
		assert.strictEqual(v4.received('puback')[0].messageId, 9);
		assert.deepStrictEqual(v5.received('suback')[0].granted, [0]);
		// each connection's later packets parse by its own version, whatever the parser read last
		v5.read(v5.encode({ cmd: 'publish', topic: `${name}/five`, payload: '{"value":5}', qos: 1, messageId: 4 }));
		// retained, so the record shows what the payload parsed to
		v4.read(
			v4.encode({ cmd: 'publish', topic: `${name}/four`, payload: '{"value":44}', qos: 1, messageId: 10, retain: true })
		);
		await waitFor(() => v4.received('puback').length === 2 && v5.received('puback').length === 1);
		await waitFor(async () => (await T.get('four'))?.value === 44);
		v4.socket.handlers.close();
		v5.socket.handlers.close();
	});

	it('parses a v5 CONNECT split across reads with its properties, and takes nothing from a connection closed mid-packet', async () => {
		const control = client(listener, 5);
		const v5 = client(listener, 5);
		const v4 = client(listener, 4);
		const closing = client(listener, 4);
		control.read(
			control.encode({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 5, clientId: 'props-control', clean: true })
		);
		closing.read(
			closing.encode({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clientId: 'props-closing', clean: true })
		);
		await waitFor(() => control.received('connack').length === 1 && closing.received('connack').length === 1);
		// asks for no problem information, so a refusal reaches it without the reason string the control gets
		const connect = v5.encode({
			cmd: 'connect',
			protocolId: 'MQTT',
			protocolVersion: 5,
			clientId: 'props-v5',
			clean: true,
			properties: { requestProblemInformation: false },
		});
		v5.read(connect.subarray(0, 12));
		// a connection that closes with a packet half read, while other connections parse theirs
		const publish = closing.encode({
			cmd: 'publish',
			topic: `${name}/never`,
			payload: '{"value":1}',
			qos: 1,
			messageId: 1,
		});
		closing.read(publish.subarray(0, publish.length - 4));
		closing.socket.handlers.close();
		v4.read(v4.encode({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clientId: 'props-v4', clean: true }));
		v5.read(connect.subarray(12));
		await waitFor(() => v5.received('connack').length === 1 && v4.received('connack').length === 1);
		const refused = { cmd: 'subscribe', messageId: 2, subscriptions: [{ topic: 'NoSuchResourceForProps/x', qos: 0 }] };
		control.read(control.encode(refused));
		v5.read(v5.encode(refused));
		v4.read(v4.encode({ cmd: 'pingreq' }));
		await waitFor(
			() =>
				control.received('suback').length === 1 &&
				v5.received('suback').length === 1 &&
				v4.received('pingresp').length === 1
		);
		assert.ok(control.received('suback')[0].properties?.reasonString, 'a refused SUBSCRIBE carries a reason string');
		assert.ok(v5.received('suback')[0].granted[0] >= 0x80, 'the SUBSCRIBE was refused');
		assert.strictEqual(
			v5.received('suback')[0].properties?.reasonString,
			undefined,
			"the CONNECT's properties were lost"
		);
		for (const connection of [control, v5, v4]) connection.socket.handlers.close();
	});

	/** Counts the parsers mqtt-packet makes while `run` runs, and records each one parsing. */
	async function watchParsers(run) {
		const makeParser = Parser.parser;
		const parse = Parser.prototype.parse;
		const watched = { made: 0, parsing: [] };
		Parser.parser = function (options) {
			if (this instanceof Parser) watched.made++;
			return makeParser.call(this, options);
		};
		Parser.prototype.parse = function (data) {
			watched.parsing.push(this);
			return parse.call(this, data);
		};
		try {
			await run(watched);
		} finally {
			Parser.parser = makeParser;
			Parser.prototype.parse = parse;
		}
		return watched;
	}

	// More connections than the idle parsers kept, so a parser given back at each packet's end would be remade.
	it('makes no parser for each packet split across reads, however many connections stream at once', async () => {
		const connections = [];
		for (let i = 0; i < 100; i++) {
			const connection = client(listener, 4);
			connection.read(
				connection.encode({
					cmd: 'connect',
					protocolId: 'MQTT',
					protocolVersion: 4,
					clientId: `stream-${i}`,
					clean: true,
				})
			);
			connections.push(connection);
		}
		await waitFor(() => connections.every((connection) => connection.received('connack').length === 1));
		const ping = connections[0].encode({ cmd: 'pingreq' });
		const round = () => {
			for (const connection of connections) connection.read(ping.subarray(0, 1));
			for (const connection of connections) connection.read(Buffer.concat([ping.subarray(1), ping.subarray(0, 1)]));
			for (const connection of connections) connection.read(ping.subarray(1));
		};
		round();
		const { made } = await watchParsers(() => {
			for (let i = 0; i < 5; i++) round();
		});
		assert.strictEqual(made, 0, `${made} parsers made for streams already under way`);
		await waitFor(() => connections.every((connection) => connection.received('pingresp').length === 12));
		for (const connection of connections) connection.socket.handlers.close();
	});

	it('makes no parser for each read of whole packets', async () => {
		const connections = [];
		for (let i = 0; i < 10; i++) {
			const connection = client(listener, 4);
			connection.read(
				connection.encode({
					cmd: 'connect',
					protocolId: 'MQTT',
					protocolVersion: 4,
					clientId: `whole-${i}`,
					clean: true,
				})
			);
			connections.push(connection);
		}
		await waitFor(() => connections.every((connection) => connection.received('connack').length === 1));
		const ping = connections[0].encode({ cmd: 'pingreq' });
		const { made } = await watchParsers(() => {
			for (let i = 0; i < 5; i++) for (const connection of connections) connection.read(ping);
		});
		assert.strictEqual(made, 0, `${made} parsers made for reads of whole packets`);
		await waitFor(() => connections.every((connection) => connection.received('pingresp').length === 5));
		for (const connection of connections) connection.socket.handlers.close();
	});

	// A QoS 1 subscriber often sends nothing but PUBACKs, which skip the parser.
	it('gives back a parser kept for a stream once the connection sends only whole acknowledgements', async () => {
		const [streaming, other] = [client(listener, 4), client(listener, 4)];
		for (const [connection, clientId] of [
			[streaming, 'acks-after-stream'],
			[other, 'acks-other'],
		]) {
			connection.read(
				connection.encode({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clientId, clean: true })
			);
		}
		await waitFor(() => streaming.received('connack').length === 1 && other.received('connack').length === 1);
		const ping = streaming.encode({ cmd: 'pingreq' });
		const { parsing } = await watchParsers(() => {
			// it ends a read mid-packet, then completes the packet: it keeps the parser for its stream
			streaming.read(ping.subarray(0, 1));
			streaming.read(ping.subarray(1));
			streaming.read(streaming.encode({ cmd: 'puback', messageId: 1 }));
			other.read(ping);
		});
		const [kept] = parsing;
		assert.strictEqual(parsing.at(-1), kept, 'the other connection parses with the parser the stream gave back');
		await waitFor(() => streaming.received('pingresp').length === 1 && other.received('pingresp').length === 1);
		streaming.socket.handlers.close();
		other.socket.handlers.close();
	});

	it('keeps no CONNECT, which carries its password, on a parser left mid-packet by the read it came in', async () => {
		const connection = client(listener, 4);
		const connect = connection.encode({
			cmd: 'connect',
			protocolId: 'MQTT',
			protocolVersion: 4,
			clientId: 'connect-then-partial',
			clean: true,
			username: 'someone',
			password: Buffer.from('a secret'),
		});
		const ping = connection.encode({ cmd: 'pingreq' });
		const { parsing } = await watchParsers(() => connection.read(Buffer.concat([connect, ping.subarray(0, 1)])));
		const held = parsing.at(-1);
		assert.strictEqual(held.settings.password, undefined);
		assert.strictEqual(held.settings.protocolVersion, 4);
		connection.socket.handlers.close();
	});

	it('holds no parser for a connection between packets', async function () {
		if (typeof v8.queryObjects !== 'function') this.skip();
		const parsers = () => {
			global.gc?.();
			return v8.queryObjects(Parser, { format: 'count' });
		};
		const clients = [];
		for (let i = 0; i < 20; i++) {
			const connection = client(listener, 4);
			connection.read(
				connection.encode({
					cmd: 'connect',
					protocolId: 'MQTT',
					protocolVersion: 4,
					clientId: `idle-${i}`,
					clean: true,
				})
			);
			clients.push(connection);
		}
		await waitFor(() => clients.every((connection) => connection.received('connack').length === 1));
		const idle = parsers();
		assert.ok(idle <= 2, `${idle} parsers for 20 connections between packets`);
		// one with a packet half read keeps a parser until it has the rest
		const ping = clients[0].encode({ cmd: 'pingreq' });
		clients[0].read(ping.subarray(0, 1));
		clients[1].read(ping);
		assert.ok(parsers() <= idle + 1);
		clients[0].read(ping.subarray(1));
		await waitFor(() => clients[0].received('pingresp').length === 1 && clients[1].received('pingresp').length === 1);
		for (const connection of clients) connection.socket.handlers.close();
	});
});
