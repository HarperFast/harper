'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');
const path = require('path');
const fs = require('fs');

const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const EventEmitter = require('events');
const {
	writeUdsMetadata,
	registerUdsCleanupPaths,
	cleanupUdsFiles,
	cleanupSocketsDirectory,
	enableProxyProtocol,
} = require('#src/server/http');

const TEST_SOCKETS_DIR = path.join(testUtils.ENV_DIR_PATH, 'sockets');

// Build a mock secure server whose secureContexts mirrors the Map returned by createTLSSelector
function makeSecureServer(certs = []) {
	const contexts = new Map();
	for (const { name, hostnames, key_file, cert, cas } of certs) {
		const ctx = {
			name,
			options: { cert, key_file },
			certificateAuthorities: cas ?? [],
		};
		for (const hostname of hostnames) {
			contexts.set(hostname, ctx);
		}
	}
	return { secureContexts: contexts };
}

describe('UDS mirror (writeUdsMetadata, cleanup helpers)', () => {
	let sandbox;

	before(() => {
		fs.mkdirSync(TEST_SOCKETS_DIR, { recursive: true });
	});

	beforeEach(() => {
		sandbox = sinon.createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
		// Remove any files left in the sockets dir between tests
		try {
			for (const f of fs.readdirSync(TEST_SOCKETS_DIR)) {
				try {
					fs.unlinkSync(path.join(TEST_SOCKETS_DIR, f));
				} catch {}
			}
		} catch {} // dir may have been removed by a test
	});

	after(() => {
		testUtils.cleanUpDirectories(TEST_SOCKETS_DIR);
	});

	// ─── writeUdsMetadata ─────────────────────────────────────────────────────

	describe('writeUdsMetadata', () => {
		it('writes pid, tid, and port to the YAML file', () => {
			const yamlPath = path.join(TEST_SOCKETS_DIR, '0-9926.yaml');
			writeUdsMetadata(yamlPath, 9926, makeSecureServer());
			const content = fs.readFileSync(yamlPath, 'utf8');
			assert.match(content, /^pid: \d+$/m);
			assert.match(content, /^tid: \d+$/m);
			assert.match(content, /^port: 9926$/m);
		});

		it('writes certificate name and hostnames', () => {
			const yamlPath = path.join(TEST_SOCKETS_DIR, '0-9926.yaml');
			const server = makeSecureServer([
				{
					name: 'my-cert',
					hostnames: ['example.com', '*.example.com'],
					cert: '-----BEGIN CERTIFICATE-----\nABCD\n-----END CERTIFICATE-----',
				},
			]);
			writeUdsMetadata(yamlPath, 9926, server);
			const content = fs.readFileSync(yamlPath, 'utf8');
			assert.match(content, /name: "my-cert"/);
			assert.match(content, /"example\.com"/);
			assert.match(content, /"\*\.example\.com"/);
		});

		it('writes certificate PEM as a YAML block scalar', () => {
			const yamlPath = path.join(TEST_SOCKETS_DIR, '0-9926.yaml');
			const certPem = '-----BEGIN CERTIFICATE-----\nABCD1234\n-----END CERTIFICATE-----';
			const server = makeSecureServer([{ name: 'c', hostnames: ['h.example.com'], cert: certPem }]);
			writeUdsMetadata(yamlPath, 9926, server);
			const content = fs.readFileSync(yamlPath, 'utf8');
			assert.ok(content.includes('    certificate: |'), 'should use block scalar indicator');
			assert.ok(content.includes('      -----BEGIN CERTIFICATE-----'), 'should indent cert lines');
		});

		it('includes privateKeyFile path when key_file is present', () => {
			const yamlPath = path.join(TEST_SOCKETS_DIR, '0-9926.yaml');
			sandbox.stub(env, 'get').withArgs(terms.CONFIG_PARAMS.ROOTPATH).returns('/opt/harperdb');
			const server = makeSecureServer([
				{
					name: 'c',
					hostnames: ['h.example.com'],
					cert: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----',
					key_file: 'server.key',
				},
			]);
			writeUdsMetadata(yamlPath, 9926, server);
			const content = fs.readFileSync(yamlPath, 'utf8');
			assert.match(content, /privateKeyFile: "\/opt\/harperdb\/keys\/server\.key"/);
		});

		it('writes certificate authorities when present', () => {
			const yamlPath = path.join(TEST_SOCKETS_DIR, '0-9926.yaml');
			const caPem = '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----';
			const server = makeSecureServer([
				{
					name: 'c',
					hostnames: ['h.example.com'],
					cert: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----',
					cas: [['issuer-subject', caPem]],
				},
			]);
			writeUdsMetadata(yamlPath, 9926, server);
			const content = fs.readFileSync(yamlPath, 'utf8');
			assert.ok(content.includes('    certificateAuthorities:'), 'should include CA section');
			assert.ok(content.includes('      - |'), 'should use block scalar for CA');
			assert.ok(content.includes('-----BEGIN CERTIFICATE-----'), 'should include CA PEM');
		});

		it('writes empty certificates list when secureContexts is empty', () => {
			const yamlPath = path.join(TEST_SOCKETS_DIR, '0-9926.yaml');
			writeUdsMetadata(yamlPath, 9926, makeSecureServer());
			const content = fs.readFileSync(yamlPath, 'utf8');
			assert.match(content, /^certificates:\s*$/m);
			assert.ok(!content.includes('  - name:'), 'should not have any cert entries');
		});

		it('de-duplicates contexts that are shared across multiple hostnames', () => {
			const yamlPath = path.join(TEST_SOCKETS_DIR, '0-9926.yaml');
			// Two hostnames pointing to the same context object
			const ctx = {
				name: 'wildcard-cert',
				options: { cert: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----' },
				certificateAuthorities: [],
			};
			const secureServer = {
				secureContexts: new Map([
					['a.example.com', ctx],
					['b.example.com', ctx],
				]),
			};
			writeUdsMetadata(yamlPath, 9926, secureServer);
			const content = fs.readFileSync(yamlPath, 'utf8');
			const nameMatches = [...content.matchAll(/name: "wildcard-cert"/g)];
			assert.strictEqual(nameMatches.length, 1, 'cert entry should appear only once');
		});

		it('logs an error if the file cannot be written', () => {
			const harperLogger = require('#src/utility/logging/harper_logger');
			const errorStub = sandbox.stub(harperLogger, 'error');
			// Use an invalid path that cannot be written
			writeUdsMetadata('/nonexistent-dir/missing/0-9926.yaml', 9926, makeSecureServer());
			assert.ok(errorStub.calledOnce, 'should log the write error');
			assert.ok(errorStub.firstCall.args[0].includes('Error writing UDS metadata'));
		});
	});

	// ─── enableProxyProtocol ──────────────────────────────────────────────────

	describe('enableProxyProtocol', () => {
		// Install the wrapper, then deliver one or more chunks as the fronting proxy would.
		async function feed(socket, ...chunks) {
			const server = new EventEmitter();
			enableProxyProtocol(server);
			const received = [];
			socket.on('data', (c) => received.push(c)); // stand-in for the protocol parser
			server.emit('connection', socket);
			await new Promise((resolve) => process.nextTick(resolve));
			for (const chunk of chunks) socket.emit('data', chunk);
			return received;
		}

		it('strips the PROXY v1 header and forwards the remaining bytes', async () => {
			const socket = new EventEmitter();
			const received = await feed(socket, Buffer.from('PROXY TCP4 1.2.3.4 5.6.7.8 1111 2222\r\nHELLO'));
			assert.strictEqual(Buffer.concat(received).toString(), 'HELLO');
			assert.strictEqual(socket.remoteAddress, '1.2.3.4');
			assert.strictEqual(socket.remotePort, 1111);
		});

		it('forwards a non-PROXY first chunk unchanged (e.g. an MQTT CONNECT)', async () => {
			const socket = new EventEmitter();
			const received = await feed(socket, Buffer.from('MQTTCONNECT'));
			assert.strictEqual(Buffer.concat(received).toString(), 'MQTTCONNECT');
		});

		it('buffers a PROXY header split across data events (no partial leak to the parser)', async () => {
			const socket = new EventEmitter();
			const received = await feed(
				socket,
				Buffer.from('PROXY TCP4 1.2.3.4 5.6.7.8 1111'), // no CRLF yet
				Buffer.from(' 2222\r\nHELLO')
			);
			// Nothing forwarded until the header completes; then only the payload.
			assert.strictEqual(Buffer.concat(received).toString(), 'HELLO');
			assert.strictEqual(socket.remoteAddress, '1.2.3.4');
		});

		it('buffers when the first chunk is shorter than the "PROXY " prefix', async () => {
			const socket = new EventEmitter();
			const received = await feed(socket, Buffer.from('PRO'), Buffer.from('XY TCP4 9.9.9.9 5.6.7.8 42 2222\r\nHI'));
			assert.strictEqual(Buffer.concat(received).toString(), 'HI');
			assert.strictEqual(socket.remoteAddress, '9.9.9.9');
		});

		it('forwards unchanged once the spec max length is exceeded without a CRLF', async () => {
			const socket = new EventEmitter();
			const long = 'PROXY ' + 'x'.repeat(200); // > 108 bytes, no CRLF
			const received = await feed(socket, Buffer.from(long));
			assert.strictEqual(Buffer.concat(received).toString(), long);
		});
<<<<<<< HEAD
=======

		// PROXY v2 (binary) — built the way a fronting proxy like symphony emits it
		function buildV2Header(tlvBlock = Buffer.alloc(0)) {
			const addresses = Buffer.from([203, 0, 113, 9, 127, 0, 0, 1, 0xb2, 0x6e /* 45678 */, 0, 0]);
			const header = Buffer.alloc(16);
			Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]).copy(header, 0);
			header[12] = 0x21; // v2, PROXY command
			header[13] = 0x11; // TCP over IPv4
			header.writeUInt16BE(addresses.length + tlvBlock.length, 14);
			return Buffer.concat([header, addresses, tlvBlock]);
		}

		it('strips a PROXY v2 header and overrides remoteAddress/remotePort', async () => {
			const socket = createSocket();
			const received = await feed(socket, Buffer.concat([buildV2Header(), Buffer.from('HELLO')]));
			assert.strictEqual(Buffer.concat(received).toString(), 'HELLO');
			assert.strictEqual(socket.remoteAddress, '203.0.113.9');
			assert.strictEqual(socket.remotePort, 45678);
		});

		it('buffers a PROXY v2 header split across data events', async () => {
			const socket = createSocket();
			const full = Buffer.concat([buildV2Header(), Buffer.from('HELLO')]);
			const received = await feed(socket, full.subarray(0, 7), full.subarray(7, 20), full.subarray(20));
			assert.strictEqual(Buffer.concat(received).toString(), 'HELLO');
			assert.strictEqual(socket.remoteAddress, '203.0.113.9');
		});

		it('exposes a forwarded client cert with TLSSocket semantics', async () => {
			// SSL TLV (0x20): client = SSL|CERT_CONN, verify = 0; then a 0xE0 cert TLV
			const ssl = Buffer.from([0x20, 0x00, 0x05, 0x03, 0, 0, 0, 0]);
			const der = Buffer.from('not-a-real-der-but-forwarded-opaquely');
			const certTlv = Buffer.concat([Buffer.from([0xe2, 0x00, der.length]), der]);
			const socket = createSocket();
			await feed(socket, Buffer.concat([buildV2Header(Buffer.concat([ssl, certTlv])), Buffer.from('APP')]));
			assert.strictEqual(socket.authorized, true);
			assert.strictEqual(typeof socket.getPeerCertificate, 'function');
		});

		it('gives non-proxied connections no-client-cert TLS defaults', async () => {
			const socket = createSocket();
			await feed(socket, Buffer.from('MQTTCONNECT'));
			assert.strictEqual(socket.authorized, false);
			assert.deepStrictEqual(socket.getPeerCertificate(), {});
		});

		it('destroys the connection if the peer stalls before completing the header', async () => {
			const socket = createSocket();
			const server = new EventEmitter();
			enableProxyProtocol(server);
			socket.on('data', () => {}); // stand-in for the HTTP parser's own listener
			server.emit('connection', socket);
			await new Promise((resolve) => process.nextTick(resolve));
			socket.emit('data', Buffer.from('PROXY TCP4 1.2.3.4')); // no CRLF yet — still pending
			socket.emit('timeout');
			assert.strictEqual(socket.destroy.called, true);
		});

		it('clears the stall timeout once the header resolves', async () => {
			const socket = createSocket();
			await feed(socket, Buffer.from('PROXY TCP4 1.2.3.4 5.6.7.8 1111 2222\r\nHELLO'));
			socket.emit('timeout'); // an unrelated later timeout must be a no-op post-handoff
			assert.strictEqual(socket.destroy.called, false);
		});

		it('uninstalls its wrapper and restores the original listeners once the header resolves', async () => {
			// The wrapper must not outlive the header decision: Node's HTTP upgrade path
			// removes the parser's 'data' listener by reference before ws takes over, so a
			// lingering wrapper would keep feeding the freed (re-poolable) parser.
			const socket = createSocket();
			const server = new EventEmitter();
			enableProxyProtocol(server);
			const parserListener = () => {};
			socket.on('data', parserListener);
			server.emit('connection', socket);
			await new Promise((resolve) => process.nextTick(resolve));
			socket.emit('data', Buffer.from('PROXY TCP4 1.2.3.4 5.6.7.8 1111 2222\r\nHELLO'));
			assert.deepStrictEqual(socket.listeners('data'), [parserListener]);
		});
	});

	// ─── WS upgrade through the UDS mirror path (real sockets) ────────────────

	describe('WebSocket upgrade over a proxy-protocol UDS server', () => {
		// End-to-end regression for the two defects that silently killed WS on the UDS
		// mirrors: a mirror with no 'upgrade' listener destroys the socket with a
		// zero-byte close, and the old enableProxyProtocol wrapper kept forwarding
		// post-upgrade frames into the freed HTTP parser (which the pool can re-issue
		// to another connection, corrupting it).
		const http = require('node:http');
		const net = require('node:net');
		const crypto = require('node:crypto');
		const os = require('node:os');
		const { WebSocketServer } = require('ws');

		// Short path: sun_path is limited to ~104 bytes on macOS
		const sockPath = path.join(os.tmpdir(), `hdb-ws-uds-${process.pid}.sock`);
		let server, wss;

		before(async () => {
			try {
				fs.unlinkSync(sockPath);
			} catch {}
			server = http.createServer((request, response) => response.end('ok'));
			wss = new WebSocketServer({ noServer: true });
			wss.on('connection', (ws) => ws.on('message', (msg) => ws.send(`echo:${msg}`)));
			server.on('upgrade', (request, socket, head) => {
				wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
			});
			enableProxyProtocol(server);
			await new Promise((resolve) => server.listen(sockPath, resolve));
		});

		after(async () => {
			wss?.close();
			server.closeAllConnections?.();
			await new Promise((resolve) => server.close(resolve));
			try {
				fs.unlinkSync(sockPath);
			} catch {}
		});

		function maskedTextFrame(text) {
			const payload = Buffer.from(text);
			const mask = crypto.randomBytes(4);
			const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
			return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
		}

		function httpRequest() {
			return new Promise((resolve, reject) => {
				const client = net.connect(sockPath);
				let data = '';
				client.on('connect', () => {
					client.write('PROXY TCP4 9.9.9.9 5.6.7.8 3333 2222\r\n');
					client.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
				});
				client.on('data', (chunk) => (data += chunk));
				client.on('close', () => resolve(data.split('\r\n')[0]));
				client.on('error', reject);
			});
		}

		it('completes the handshake, echoes frames, and leaves pooled parsers intact', async () => {
			const client = net.connect(sockPath);
			const key = crypto.randomBytes(16).toString('base64');
			let clientError = null;
			server.once('clientError', (error) => (clientError = error));

			const status = await new Promise((resolve, reject) => {
				let data = Buffer.alloc(0);
				client.on('connect', () => {
					client.write('PROXY TCP4 1.2.3.4 5.6.7.8 1111 2222\r\n');
					client.write(
						`GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
							`Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`
					);
				});
				client.on('data', function onHandshake(chunk) {
					data = Buffer.concat([data, chunk]);
					if (data.includes('\r\n\r\n')) {
						client.removeListener('data', onHandshake);
						resolve(data.toString().split('\r\n')[0]);
					}
				});
				client.on('error', reject);
				client.on('close', () => reject(new Error('connection closed before handshake response')));
			});
			assert.strictEqual(status, 'HTTP/1.1 101 Switching Protocols');

			// Run another HTTP request first so the freed parser is re-issued from the
			// pool; frames on the upgraded socket must not reach it.
			assert.strictEqual(await httpRequest(), 'HTTP/1.1 200 OK');

			const echoed = new Promise((resolve, reject) => {
				let frame = Buffer.alloc(0);
				client.on('data', (chunk) => {
					frame = Buffer.concat([frame, chunk]);
					const length = frame[1] & 0x7f;
					if (frame.length >= 2 + length) resolve(frame.subarray(2, 2 + length).toString());
				});
				setTimeout(() => reject(new Error('no echo received')), 3000).unref();
			});
			client.write(maskedTextFrame('hi'));
			assert.strictEqual(await echoed, 'echo:hi');
			assert.strictEqual(clientError && clientError.message, null, 'frames must not leak into pooled HTTP parsers');

			// The server must serve plain HTTP cleanly after the upgraded connection exchanged frames
			assert.strictEqual(await httpRequest(), 'HTTP/1.1 200 OK');
			client.destroy();
		});
>>>>>>> a057bca24 (fix(http): dispatch WebSocket upgrades on the UDS mirror listeners)
	});

	// ─── registerUdsCleanupPaths + cleanupUdsFiles ────────────────────────────

	describe('registerUdsCleanupPaths + cleanupUdsFiles', () => {
		it('cleanupUdsFiles removes registered socket and yaml files', () => {
			const sockPath = path.join(TEST_SOCKETS_DIR, 'test.sock');
			const yamlPath = path.join(TEST_SOCKETS_DIR, 'test.yaml');
			fs.writeFileSync(sockPath, '');
			fs.writeFileSync(yamlPath, '');

			registerUdsCleanupPaths(sockPath, yamlPath);
			cleanupUdsFiles();

			assert.ok(!fs.existsSync(sockPath), 'socket file should be removed');
			assert.ok(!fs.existsSync(yamlPath), 'yaml file should be removed');
		});

		it('cleanupUdsFiles does not throw when files are already gone', () => {
			registerUdsCleanupPaths(path.join(TEST_SOCKETS_DIR, 'ghost.sock'), path.join(TEST_SOCKETS_DIR, 'ghost.yaml'));
			assert.doesNotThrow(() => cleanupUdsFiles());
		});
	});

	// ─── cleanupSocketsDirectory ──────────────────────────────────────────────

	describe('cleanupSocketsDirectory', () => {
		it('removes all files in the sockets directory when enabled', () => {
			const socketsDir = path.join(env.getHdbBasePath(), 'sockets');
			fs.mkdirSync(socketsDir, { recursive: true });
			fs.writeFileSync(path.join(socketsDir, '0-9926.sock'), '');
			fs.writeFileSync(path.join(socketsDir, '0-9926.yaml'), '');
			fs.writeFileSync(path.join(socketsDir, '1-9926.sock'), '');

			sandbox.stub(env, 'get').withArgs(terms.CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS).returns(true);
			cleanupSocketsDirectory();

			assert.strictEqual(fs.readdirSync(socketsDir).length, 0, 'sockets dir should be empty');
			fs.rmdirSync(socketsDir);
		});

		it('does nothing when tls.unixDomainSockets is not enabled', () => {
			const socketsDir = path.join(env.getHdbBasePath(), 'sockets');
			fs.mkdirSync(socketsDir, { recursive: true });
			fs.writeFileSync(path.join(socketsDir, '0-9926.sock'), '');

			sandbox.stub(env, 'get').withArgs(terms.CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS).returns(undefined);
			cleanupSocketsDirectory();

			assert.strictEqual(fs.readdirSync(socketsDir).length, 1, 'file should remain when feature is disabled');
			fs.rmSync(socketsDir, { recursive: true });
		});

		it('does not throw when the sockets directory does not exist', () => {
			sandbox.stub(env, 'get').withArgs(terms.CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS).returns(true);
			assert.doesNotThrow(() => cleanupSocketsDirectory());
		});
	});
});
