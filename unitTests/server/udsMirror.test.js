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
			const socket = new EventEmitter();
			const received = await feed(socket, Buffer.concat([buildV2Header(), Buffer.from('HELLO')]));
			assert.strictEqual(Buffer.concat(received).toString(), 'HELLO');
			assert.strictEqual(socket.remoteAddress, '203.0.113.9');
			assert.strictEqual(socket.remotePort, 45678);
		});

		it('buffers a PROXY v2 header split across data events', async () => {
			const socket = new EventEmitter();
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
			const socket = new EventEmitter();
			await feed(socket, Buffer.concat([buildV2Header(Buffer.concat([ssl, certTlv])), Buffer.from('APP')]));
			assert.strictEqual(socket.authorized, true);
			assert.strictEqual(typeof socket.getPeerCertificate, 'function');
		});

		it('gives non-proxied connections no-client-cert TLS defaults', async () => {
			const socket = new EventEmitter();
			await feed(socket, Buffer.from('MQTTCONNECT'));
			assert.strictEqual(socket.authorized, false);
			assert.deepStrictEqual(socket.getPeerCertificate(), {});
		});
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

	// ─── writeUdsMetadata protocol marker ─────────────────────────────────────

	describe('writeUdsMetadata protocol parameter', () => {
		it('writes a protocol line when given, omits it otherwise', () => {
			const yamlPath = path.join(TEST_SOCKETS_DIR, '0-9926-h2.yaml');
			writeUdsMetadata(yamlPath, 9926, makeSecureServer(), 'h2');
			assert.match(fs.readFileSync(yamlPath, 'utf8'), /^protocol: h2$/m);
			writeUdsMetadata(yamlPath, 9926, makeSecureServer());
			assert.doesNotMatch(fs.readFileSync(yamlPath, 'utf8'), /^protocol:/m);
		});
	});

	describe('writeUdsMetadata mTLS advertisement', () => {
		it('writes mtls flags when the mirrored port verifies client certs', () => {
			const yamlPath = path.join(TEST_SOCKETS_DIR, '0-9926.yaml');
			const server = makeSecureServer();
			server.verifiesClientCerts = true;
			server.mtlsRequired = true;
			writeUdsMetadata(yamlPath, 9926, server);
			const content = fs.readFileSync(yamlPath, 'utf8');
			assert.match(content, /^mtls: true$/m);
			assert.match(content, /^mtlsRequired: true$/m);
		});

		it('omits mtls flags otherwise', () => {
			const yamlPath = path.join(TEST_SOCKETS_DIR, '0-9926.yaml');
			writeUdsMetadata(yamlPath, 9926, makeSecureServer());
			const content = fs.readFileSync(yamlPath, 'utf8');
			assert.doesNotMatch(content, /^mtls:/m);
			assert.doesNotMatch(content, /^mtlsRequired:/m);
		});

		it('omits mtls flags when the mirror cannot decode PROXY v2 (mtlsForwarding=false)', () => {
			const yamlPath = path.join(TEST_SOCKETS_DIR, '0-9926.yaml');
			const server = makeSecureServer();
			server.verifiesClientCerts = true;
			writeUdsMetadata(yamlPath, 9926, server, undefined, false);
			assert.doesNotMatch(fs.readFileSync(yamlPath, 'utf8'), /^mtls:/m);
		});
	});
});

// ─── createH2CProxyFront ──────────────────────────────────────────────────────
// Real sockets: an h2c server behind the PROXY-stripping front on a UDS path.
// These also pin the Node behavior the front depends on: bytes unshifted onto a
// net.Socket must survive Http2Session's native handle consume.

describe('createH2CProxyFront (h2c UDS mirror)', () => {
	const http2 = require('node:http2');
	const net = require('node:net');
	const os = require('node:os');
	const { createH2CProxyFront } = require('#src/server/http');

	// h2 connection preface + empty SETTINGS frame (type 4, flags 0, stream 0, len 0)
	const H2_PREFACE = Buffer.concat([
		Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'),
		Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0]),
	]);
	const PROXY_LINE = 'PROXY TCP4 203.0.113.9 127.0.0.1 45678 443\r\n';

	let h2srv, front, udsPath;

	beforeEach((done) => {
		udsPath = path.join(os.tmpdir(), `hdb-h2c-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
		h2srv = http2.createServer((req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end(`addr=${req.socket.remoteAddress ?? 'none'} port=${req.socket.remotePort ?? 0} path=${req.url}`);
		});
		h2srv.on('sessionError', () => {});
		front = createH2CProxyFront(h2srv);
		front.listen(udsPath, done);
	});

	afterEach((done) => {
		h2srv.close();
		front.close(() => {
			try {
				fs.unlinkSync(udsPath);
			} catch {}
			done();
		});
	});

	function h2Request(prepare) {
		return new Promise((resolve, reject) => {
			const session = http2.connect('http://localhost', {
				createConnection: () => {
					const socket = net.connect(udsPath);
					prepare?.(socket);
					return socket;
				},
			});
			session.on('error', reject);
			const req = session.request({ ':path': '/who' });
			let body = '';
			req.setEncoding('utf8');
			req.on('data', (d) => (body += d));
			req.on('end', () => {
				session.close();
				resolve(body);
			});
			req.on('error', reject);
			req.end();
		});
	}

	// Establish a session manually (PROXY/preface framing fully under test control)
	// and resolve on the server's SETTINGS-ACK. The server sends its own SETTINGS
	// unprompted on session creation, so only an ACK (type 0x4, flags & 0x1) proves
	// the CLIENT preface survived stripping/unshift and reached the native session.
	function rawSessionEstablishes(writes) {
		return new Promise((resolve, reject) => {
			const socket = net.connect(udsPath, async () => {
				for (const w of writes) {
					if (typeof w === 'number') await new Promise((r) => setTimeout(r, w));
					else socket.write(w);
				}
			});
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error('no SETTINGS-ACK from server'));
			}, 1500);
			let buf = Buffer.alloc(0);
			socket.on('data', (d) => {
				buf = Buffer.concat([buf, d]);
				// Walk complete frames: 3-byte length, 1-byte type, 1-byte flags, 4-byte stream id
				let off = 0;
				while (buf.length - off >= 9) {
					const len = buf.readUIntBE(off, 3);
					const type = buf[off + 3];
					const flags = buf[off + 4];
					if (type === 4 && flags & 0x1) {
						clearTimeout(timer);
						socket.destroy();
						return resolve();
					}
					if (buf.length - off < 9 + len) break;
					off += 9 + len;
				}
				buf = buf.subarray(off);
			});
			socket.on('error', reject);
		});
	}

	it('strips the PROXY header and overrides remoteAddress/remotePort', async () => {
		const body = await h2Request((socket) => socket.write(PROXY_LINE));
		assert.match(body, /addr=203\.0\.113\.9 port=45678/);
	});

	it('passes a direct h2 connection (no PROXY header) through unchanged', async () => {
		const body = await h2Request();
		assert.match(body, /path=\/who/);
		assert.doesNotMatch(body, /203\.0\.113\.9/);
	});

	it('handles the PROXY header coalesced with the preface in a single packet', async () => {
		await rawSessionEstablishes([Buffer.concat([Buffer.from(PROXY_LINE), H2_PREFACE])]);
	});

	it('handles a PROXY header split across packets', async () => {
		await rawSessionEstablishes([
			Buffer.from('PROXY TCP4 203.0.'),
			20,
			Buffer.from('113.9 127.0.0.1 45678 443\r\n'),
			H2_PREFACE,
		]);
	});

	it('hands off unparseable long first packets without stalling', async () => {
		// Starts with "PROXY " but never terminates: after 108 bytes the front must
		// give up and forward — the h2 server then fails the session (never ACKs),
		// rather than the front buffering forever.
		const junk = Buffer.from('PROXY ' + 'x'.repeat(150));
		await assert.rejects(rawSessionEstablishes([junk]), /no SETTINGS-ACK|ECONNRESET/);
	});

	it('close() sends GOAWAY to live sessions so shutdown drains gracefully', async () => {
		// Establish a real session, then close the front: the session must receive
		// GOAWAY and close promptly (well inside closeServers' 5s force-exit backstop).
		const session = http2.connect('http://localhost', {
			createConnection: () => net.connect(udsPath),
		});
		session.on('error', () => {});
		await new Promise((resolve) => session.on('connect', resolve));
		const sessionClosed = new Promise((resolve) => session.on('close', resolve));
		const frontClosed = new Promise((resolve) => front.close(resolve));
		await Promise.all([sessionClosed, frontClosed]);
	});

	it('destroys a connection that stalls before completing the PROXY header', async () => {
		// Rebuild the front with a short pre-handoff timeout: a client that sends a
		// partial header and stalls must be destroyed, not hold the fd forever.
		// (net.Server unlinks the UDS file itself on close.)
		await new Promise((resolve) => front.close(resolve));
		front = createH2CProxyFront(h2srv, 100);
		await new Promise((resolve) => front.listen(udsPath, resolve));

		const socket = net.connect(udsPath, () => socket.write('PROXY TCP4 203.0.'));
		socket.on('error', () => {});
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('stalled connection was not destroyed')), 2000);
			socket.on('close', () => {
				clearTimeout(timer);
				resolve();
			});
		});
	});
});
