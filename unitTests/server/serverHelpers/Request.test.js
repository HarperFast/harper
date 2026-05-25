'use strict';

const assert = require('node:assert/strict');
const sinon = require('sinon');

describe('Request class', function () {
	let Request;

	before(function () {
		// Clear the module from cache to ensure fresh load
		const modulePath = require.resolve('../../../server/serverHelpers/Request.ts');
		delete require.cache[modulePath];
		Request = require('#src/server/serverHelpers/Request').Request;
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('peerCertificate getter', function () {
		it('should call getPeerCertificate with true to get full certificate chain', function () {
			// Create a mock socket with getPeerCertificate method
			const mockCertificate = {
				subject: { CN: 'test-client' },
				issuer: { CN: 'test-ca' },
				raw: Buffer.from('mock-cert'),
				issuerCertificate: {
					subject: { CN: 'test-ca' },
					issuer: { CN: 'test-ca' },
					raw: Buffer.from('mock-ca-cert'),
				},
			};

			const getPeerCertificateStub = sinon.stub().returns(mockCertificate);

			const mockNodeRequest = {
				method: 'GET',
				url: '/test',
				headers: {},
				socket: {
					getPeerCertificate: getPeerCertificateStub,
					encrypted: true,
					remoteAddress: '127.0.0.1',
					authorized: true,
					server: { mtlsConfig: {} },
				},
			};

			const mockNodeResponse = {};

			// Create Request instance
			const request = new Request(mockNodeRequest, mockNodeResponse);

			// Access peerCertificate getter
			const cert = request.peerCertificate;

			// Verify getPeerCertificate was called with true
			assert(getPeerCertificateStub.calledOnce);
			assert(getPeerCertificateStub.calledWith(true));

			// Verify the certificate chain is returned
			assert.strictEqual(cert.subject.CN, 'test-client');
			assert.strictEqual(cert.issuer.CN, 'test-ca');
			assert(cert.issuerCertificate);
			assert.strictEqual(cert.issuerCertificate.subject.CN, 'test-ca');
		});

		it('should return null when socket has no certificate', function () {
			const getPeerCertificateStub = sinon.stub().returns(undefined);

			const mockNodeRequest = {
				method: 'GET',
				url: '/test',
				headers: {},
				socket: {
					getPeerCertificate: getPeerCertificateStub,
					encrypted: true,
					remoteAddress: '127.0.0.1',
					authorized: false,
					server: { mtlsConfig: {} },
				},
			};

			const mockNodeResponse = {};

			const request = new Request(mockNodeRequest, mockNodeResponse);
			const cert = request.peerCertificate;

			assert(getPeerCertificateStub.calledOnce);
			assert(getPeerCertificateStub.calledWith(true));
			assert.strictEqual(cert, null);
		});

		it('should handle empty certificate object', function () {
			const getPeerCertificateStub = sinon.stub().returns({});

			const mockNodeRequest = {
				method: 'GET',
				url: '/test',
				headers: {},
				socket: {
					getPeerCertificate: getPeerCertificateStub,
					encrypted: false,
					remoteAddress: '127.0.0.1',
					authorized: false,
					server: {},
				},
			};

			const mockNodeResponse = {};

			const request = new Request(mockNodeRequest, mockNodeResponse);
			const cert = request.peerCertificate;

			assert(getPeerCertificateStub.calledOnce);
			assert(getPeerCertificateStub.calledWith(true));
			assert.deepStrictEqual(cert, {});
		});

		it('should ensure certificate chain is available for OCSP verification', function () {
			// This test demonstrates why we need getPeerCertificate(true)
			// Without true, the issuerCertificate property would be missing

			const fullChainCert = {
				subject: { CN: 'client.example.com' },
				issuer: { CN: 'Intermediate CA' },
				raw: Buffer.from('client-cert'),
				serialNumber: '123456',
				// This issuerCertificate property is only included when getPeerCertificate(true) is called
				issuerCertificate: {
					subject: { CN: 'Intermediate CA' },
					issuer: { CN: 'Root CA' },
					raw: Buffer.from('intermediate-cert'),
					issuerCertificate: {
						subject: { CN: 'Root CA' },
						issuer: { CN: 'Root CA' },
						raw: Buffer.from('root-cert'),
						issuerCertificate: null, // Self-signed
					},
				},
			};

			const getPeerCertificateStub = sinon.stub();
			getPeerCertificateStub.withArgs(true).returns(fullChainCert);
			getPeerCertificateStub.withArgs(false).returns({
				subject: { CN: 'client.example.com' },
				issuer: { CN: 'Intermediate CA' },
				raw: Buffer.from('client-cert'),
				serialNumber: '123456',
				// Note: no issuerCertificate property when called with false
			});

			const mockNodeRequest = {
				method: 'GET',
				url: '/test',
				headers: {},
				socket: {
					getPeerCertificate: getPeerCertificateStub,
					encrypted: true,
					remoteAddress: '127.0.0.1',
					authorized: true,
					server: { mtlsConfig: {} },
				},
			};

			const request = new Request(mockNodeRequest, {});
			const cert = request.peerCertificate;

			// Verify we get the full chain
			assert(cert.issuerCertificate, 'Should have issuerCertificate property');
			assert.strictEqual(cert.issuerCertificate.subject.CN, 'Intermediate CA');
			assert(cert.issuerCertificate.issuerCertificate, 'Should have nested issuerCertificate');
			assert.strictEqual(cert.issuerCertificate.issuerCertificate.subject.CN, 'Root CA');

			// This is what OCSP verification needs - both the cert and its issuer
			assert(cert.raw, 'Should have raw certificate data');
			assert(cert.issuerCertificate.raw, 'Should have issuer raw certificate data');
		});
	});

	describe('other getters', function () {
		let mockNodeRequest, mockNodeResponse, request;

		beforeEach(function () {
			mockNodeRequest = {
				method: 'POST',
				url: '/api/test?param=value',
				headers: { host: 'example.com' },
				authority: 'example.com:443',
				httpVersion: '1.1',
				socket: {
					encrypted: true,
					remoteAddress: '192.168.1.100',
					authorized: true,
					server: { mtlsConfig: { user: 'CN' } },
					getPeerCertificate: sinon.stub().returns({}),
				},
			};

			mockNodeResponse = {};
			request = new Request(mockNodeRequest, mockNodeResponse);
		});

		it('should return correct protocol based on socket encryption', function () {
			assert.strictEqual(request.protocol, 'https');

			mockNodeRequest.socket.encrypted = false;
			assert.strictEqual(request.protocol, 'http');
		});

		it('should return correct IP address', function () {
			assert.strictEqual(request.ip, '192.168.1.100');
		});

		it('should return authorized status', function () {
			assert.strictEqual(request.authorized, true);

			mockNodeRequest.socket.authorized = false;
			assert.strictEqual(request.authorized, false);
		});

		it('should return mtlsConfig from server', function () {
			assert.deepStrictEqual(request.mtlsConfig, { user: 'CN' });
		});

		it('should return correct pathname', function () {
			assert.strictEqual(request.pathname, '/api/test');

			request.url = '/simple/path';
			assert.strictEqual(request.pathname, '/simple/path');
		});

		it('should return correct host', function () {
			assert.strictEqual(request.host, 'example.com:443');

			delete mockNodeRequest.authority;
			assert.strictEqual(request.host, 'example.com');
		});

		it('should return correct absoluteURL', function () {
			assert.strictEqual(request.absoluteURL, 'https://example.com:443/api/test?param=value');

			mockNodeRequest.socket.encrypted = false;
			assert.strictEqual(request.absoluteURL, 'http://example.com:443/api/test?param=value');
		});

		it('should handle pathname setter', function () {
			request.pathname = '/new/path';
			assert.strictEqual(request.url, '/new/path?param=value');
			assert.strictEqual(request.pathname, '/new/path');

			// Test without query string
			request.url = '/simple';
			request.pathname = '/updated';
			assert.strictEqual(request.url, '/updated');
		});

		it('should return httpVersion', function () {
			assert.strictEqual(request.httpVersion, '1.1');
		});

		it('should return isAborted status', function () {
			assert.strictEqual(request.isAborted, false);
		});
	});

	describe('signal (AbortSignal)', function () {
		const { EventEmitter } = require('node:events');

		function makeNodeRequest() {
			return {
				method: 'GET',
				url: '/test',
				headers: {},
				socket: Object.assign(new EventEmitter(), {
					encrypted: true,
					remoteAddress: '127.0.0.1',
					getPeerCertificate: sinon.stub().returns({}),
				}),
			};
		}

		function makeNodeResponse({ writableFinished = false } = {}) {
			const res = new EventEmitter();
			res.writableFinished = writableFinished;
			return res;
		}

		it('exposes a live AbortSignal that is not initially aborted', function () {
			const request = new Request(makeNodeRequest(), makeNodeResponse());
			assert.ok(request.signal instanceof AbortSignal);
			assert.strictEqual(request.signal.aborted, false);
			assert.strictEqual(request.isAborted, false);
		});

		it('aborts the signal on nodeResponse close before write is finished', function () {
			const nodeResponse = makeNodeResponse({ writableFinished: false });
			const request = new Request(makeNodeRequest(), nodeResponse);
			nodeResponse.emit('close');
			assert.strictEqual(request.signal.aborted, true);
			assert.strictEqual(request.isAborted, true);
		});

		it('does NOT abort the signal on nodeResponse close after write finishes', function () {
			const nodeResponse = makeNodeResponse({ writableFinished: true });
			const request = new Request(makeNodeRequest(), nodeResponse);
			nodeResponse.emit('close');
			assert.strictEqual(request.signal.aborted, false);
		});

		it('aborts on socket close when no nodeResponse is provided (WebSocket-upgrade path)', function () {
			const nodeRequest = makeNodeRequest();
			const request = new Request(nodeRequest);
			nodeRequest.socket.emit('close');
			assert.strictEqual(request.signal.aborted, true);
		});

		it('_abort() aborts the signal explicitly', function () {
			const request = new Request(makeNodeRequest(), makeNodeResponse());
			request._abort();
			assert.strictEqual(request.signal.aborted, true);
		});
	});

	describe('body getter', function () {
		it('should create RequestBody instance lazily', function () {
			const mockNodeRequest = {
				method: 'POST',
				url: '/test',
				headers: {},
				socket: {
					encrypted: true,
					getPeerCertificate: sinon.stub().returns({}),
				},
				on: sinon.stub(),
				pipe: sinon.stub(),
			};

			const request = new Request(mockNodeRequest, {});

			// First access creates the body
			const body1 = request.body;
			// Second access returns the same instance
			const body2 = request.body;

			assert.strictEqual(body1, body2);
		});

		it('should proxy event handling to node request', function () {
			const onStub = sinon.stub();
			const mockNodeRequest = {
				method: 'POST',
				url: '/test',
				headers: {},
				socket: {
					encrypted: true,
					getPeerCertificate: sinon.stub().returns({}),
				},
				on: onStub,
			};

			const request = new Request(mockNodeRequest, {});
			const body = request.body;
			const listener = () => {};

			const result = body.on('data', listener);

			assert(onStub.calledOnce);
			assert(onStub.calledWith('data', listener));
			assert.strictEqual(result, body); // Should return this for chaining
		});

		it('should proxy pipe to node request', function () {
			const pipeStub = sinon.stub().returns('piped');
			const mockNodeRequest = {
				method: 'POST',
				url: '/test',
				headers: {},
				socket: {
					encrypted: true,
					getPeerCertificate: sinon.stub().returns({}),
				},
				pipe: pipeStub,
			};

			const request = new Request(mockNodeRequest, {});
			const body = request.body;
			const destination = {};
			const options = { end: false };

			const result = body.pipe(destination, options);

			assert(pipeStub.calledOnce);
			assert(pipeStub.calledWith(destination, options));
			assert.strictEqual(result, 'piped');
		});
	});

	describe('sendEarlyHints method', function () {
		it('should send early hints with link header', function () {
			const writeEarlyHintsStub = sinon.stub();
			const mockNodeRequest = {
				method: 'GET',
				url: '/test',
				headers: {},
				socket: {
					encrypted: true,
					getPeerCertificate: sinon.stub().returns({}),
				},
			};
			const mockNodeResponse = {
				writeEarlyHints: writeEarlyHintsStub,
			};

			const request = new Request(mockNodeRequest, mockNodeResponse);

			request.sendEarlyHints('</styles.css>; rel=preload; as=style');

			assert(writeEarlyHintsStub.calledOnce);
			assert.deepStrictEqual(writeEarlyHintsStub.firstCall.args[0], {
				link: '</styles.css>; rel=preload; as=style',
			});
		});

		it('should merge link with additional headers', function () {
			const writeEarlyHintsStub = sinon.stub();
			const mockNodeResponse = {
				writeEarlyHints: writeEarlyHintsStub,
			};

			const request = new Request(
				{
					method: 'GET',
					url: '/test',
					headers: {},
					socket: {
						encrypted: true,
						getPeerCertificate: sinon.stub().returns({}),
					},
				},
				mockNodeResponse
			);

			const additionalHeaders = { 'x-custom': 'value' };
			request.sendEarlyHints('</script.js>; rel=preload; as=script', additionalHeaders);

			assert(writeEarlyHintsStub.calledOnce);
			assert.deepStrictEqual(writeEarlyHintsStub.firstCall.args[0], {
				'link': '</script.js>; rel=preload; as=script',
				'x-custom': 'value',
			});
		});
	});

	describe('withNodeAdapter', function () {
		let mockNodeRequest;

		beforeEach(function () {
			mockNodeRequest = {
				method: 'GET',
				url: '/original',
				headers: { 'host': 'example.com', 'content-type': 'text/plain' },
				httpVersion: '1.1',
				socket: {
					encrypted: false,
					remoteAddress: '127.0.0.1',
					authorized: false,
					server: {},
					getPeerCertificate: sinon.stub().returns(null),
				},
				on: sinon.stub().returnsThis(),
				pipe: sinon.stub(),
			};
		});

		function makeRequest(overrides = {}) {
			return new Request({ ...mockNodeRequest, ...overrides }, {});
		}

		describe('nodeRequest argument', function () {
			it('reflects current method and url', function () {
				const request = makeRequest();
				request.method = 'POST';
				request.url = '/modified';

				let capturedReq;
				request.withNodeAdapter((req, res) => {
					capturedReq = req;
					res.end();
				});

				assert.strictEqual(capturedReq.method, 'POST');
				assert.strictEqual(capturedReq.url, '/modified');
			});

			it('reflects middleware-mutated headers', function () {
				const request = makeRequest();
				request.headers.set('x-custom', 'added');

				let capturedReq;
				request.withNodeAdapter((req, res) => {
					capturedReq = req;
					res.end();
				});

				assert.strictEqual(capturedReq.headers['x-custom'], 'added');
				assert.strictEqual(capturedReq.headers['content-type'], 'text/plain');
			});

			it('has lowercase header keys', function () {
				const request = makeRequest({
					headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer tok' },
				});

				let capturedReq;
				request.withNodeAdapter((req, res) => {
					capturedReq = req;
					res.end();
				});

				assert.ok('content-type' in capturedReq.headers);
				assert.ok('authorization' in capturedReq.headers);
				assert.strictEqual(capturedReq.headers['content-type'], 'application/json');
			});

			it('delegates socket to the underlying IncomingMessage socket', function () {
				const request = makeRequest();

				let capturedReq;
				request.withNodeAdapter((req, res) => {
					capturedReq = req;
					res.end();
				});

				assert.strictEqual(capturedReq.socket, mockNodeRequest.socket);
			});
		});

		describe('nodeResponse — writeHead', function () {
			it('resolves response with correct status and headers', async function () {
				const request = makeRequest();
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.writeHead(201, { 'content-type': 'application/json' });
					res.end();
				});

				const resolved = await responsePromise;
				assert.strictEqual(resolved.status, 201);
				assert.strictEqual(resolved.headers.get('content-type'), 'application/json');
			});

			it('is idempotent — second writeHead call is a no-op', async function () {
				const request = makeRequest();
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.writeHead(200, { 'x-first': 'yes' });
					res.writeHead(500, { 'x-first': 'overwritten' });
					res.end();
				});

				const { status, headers } = await responsePromise;
				assert.strictEqual(status, 200);
				assert.strictEqual(headers.get('x-first'), 'yes');
			});

			it('accepts array-of-pairs header format', async function () {
				const request = makeRequest();
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.writeHead(200, [['x-pair', 'value']]);
					res.end();
				});

				const { headers } = await responsePromise;
				assert.strictEqual(headers.get('x-pair'), 'value');
			});

			it('accepts flat alternating-array header format', async function () {
				const request = makeRequest();
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.writeHead(200, ['x-flat', 'one', 'x-other', 'two']);
					res.end();
				});

				const { headers } = await responsePromise;
				assert.strictEqual(headers.get('x-flat'), 'one');
				assert.strictEqual(headers.get('x-other'), 'two');
			});

			it('sets headersSent after writeHead', function () {
				const request = makeRequest();
				let capturedRes;
				request.withNodeAdapter((req, res) => {
					capturedRes = res;
					assert.strictEqual(res.headersSent, false);
					res.writeHead(200);
					assert.strictEqual(res.headersSent, true);
					res.end();
				});

				assert.ok(capturedRes.headersSent);
			});
		});

		describe('nodeResponse — setHeader / end path', function () {
			it('resolves response with headers set before end()', async function () {
				const request = makeRequest();
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.setHeader('content-type', 'text/html');
					res.end('<h1>hi</h1>');
				});

				const { status, headers } = await responsePromise;
				assert.strictEqual(status, 200);
				assert.strictEqual(headers.get('content-type'), 'text/html');
			});

			it('captures statusCode set directly', async function () {
				const request = makeRequest();
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.statusCode = 404;
					res.end();
				});

				const { status } = await responsePromise;
				assert.strictEqual(status, 404);
			});

			it('getHeader / hasHeader / removeHeader work', function () {
				const request = makeRequest();
				request.withNodeAdapter((req, res) => {
					res.setHeader('x-test', 'abc');
					assert.strictEqual(res.getHeader('x-test'), 'abc');
					assert.ok(res.hasHeader('x-test'));

					res.removeHeader('x-test');
					assert.ok(!res.hasHeader('x-test'));

					res.end();
				});
			});
		});

		describe('nodeResponse — body streaming', function () {
			async function collectBody(stream) {
				const chunks = [];
				for await (const chunk of stream) {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				}
				return Buffer.concat(chunks).toString();
			}

			it('end() with a chunk delivers the body', async function () {
				const request = makeRequest();
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.end('hello world');
				});

				const { body } = await responsePromise;
				assert.strictEqual(await collectBody(body), 'hello world');
			});

			it('multiple write() calls are streamed in order', async function () {
				const request = makeRequest();
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.write('chunk1');
					res.write('chunk2');
					res.end('chunk3');
				});

				const { body } = await responsePromise;
				assert.strictEqual(await collectBody(body), 'chunk1chunk2chunk3');
			});

			it('end() with no body yields an empty body', async function () {
				const request = makeRequest();
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.end();
				});

				const { body } = await responsePromise;
				assert.strictEqual(await collectBody(body), '');
			});

			it('sets writableEnded after end()', async function () {
				const request = makeRequest();
				let capturedRes;
				const responsePromise = request.withNodeAdapter((req, res) => {
					capturedRes = res;
					assert.strictEqual(res.writableEnded, false);
					res.end();
					assert.strictEqual(res.writableEnded, true);
				});

				await responsePromise;
				assert.ok(capturedRes.writableEnded);
			});

			it('emits finish event after body is fully written', async function () {
				const request = makeRequest();
				const finishSpy = sinon.spy();
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.on('finish', finishSpy);
					res.end('done');
				});

				await responsePromise;
				// Wait for finish to propagate through the PassThrough
				await new Promise((resolve) => setImmediate(resolve));
				assert.ok(finishSpy.calledOnce);
			});

			it('write() invokes callback-as-second-arg after chunk is written', async function () {
				const request = makeRequest();
				let called = false;
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.write('hello', () => {
						called = true;
					});
					res.end();
				});

				const { body } = await responsePromise;
				await collectBody(body);
				assert.ok(called);
			});

			it('end() invokes callback-as-second-arg after body is flushed', async function () {
				const request = makeRequest();
				let called = false;
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.end('done', () => {
						called = true;
					});
				});

				const { body } = await responsePromise;
				await collectBody(body);
				assert.ok(called);
			});
		});

		describe('nodeResponse — setHeader multi-value', function () {
			it('preserves Set-Cookie as separate values', async function () {
				const request = makeRequest();
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.setHeader('Set-Cookie', ['session=abc; Path=/', 'csrf=xyz; Path=/']);
					res.end();
				});

				const { headers } = await responsePromise;
				const cookieValue = headers.get('Set-Cookie');
				assert.ok(Array.isArray(cookieValue), 'Set-Cookie should be an array, not a joined string');
				assert.strictEqual(cookieValue.length, 2);
				assert.strictEqual(cookieValue[0], 'session=abc; Path=/');
				assert.strictEqual(cookieValue[1], 'csrf=xyz; Path=/');
			});

			it('setHeader with a single string value works normally', async function () {
				const request = makeRequest();
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.setHeader('content-type', 'text/plain');
					res.end();
				});

				const { headers } = await responsePromise;
				assert.strictEqual(headers.get('content-type'), 'text/plain');
			});
		});

		describe('nodeResponse — destroy', function () {
			it('rejects the response promise with the provided error', async function () {
				const request = makeRequest();
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.destroy(new Error('stream destroyed'));
				});

				await assert.rejects(() => responsePromise, /stream destroyed/);
			});

			it('rejects the response promise when destroyed with no error', async function () {
				const request = makeRequest();
				const responsePromise = request.withNodeAdapter((req, res) => {
					res.destroy();
				});

				await assert.rejects(() => responsePromise, /destroyed before headers/);
			});

			it('does not reject the response promise when destroy called after headers flushed', async function () {
				const request = makeRequest();
				let capturedRes;
				const responsePromise = request.withNodeAdapter((req, res) => {
					capturedRes = res;
					res.end('body');
				});

				const { body } = await responsePromise;
				// Attach error handler so the post-flush destroy error has a listener
				body.on('error', () => {});

				capturedRes.destroy(new Error('late destroy'));
			});

			it('propagates destroy error to body consumer after headers are flushed', async function () {
				const request = makeRequest();
				let capturedRes;
				const responsePromise = request.withNodeAdapter((req, res) => {
					capturedRes = res;
					res.write('partial');
					// deliberately do NOT call end() — destroy simulates a mid-stream abort
				});

				const { body } = await responsePromise;

				// Collect body, expecting the stream error to be thrown
				const bodyErrorPromise = new Promise((resolve, reject) => {
					body.on('error', reject);
					body.on('end', resolve);
				});

				capturedRes.destroy(new Error('connection reset'));

				await assert.rejects(() => bodyErrorPromise, /connection reset/);
			});
		});

		describe('async handler', function () {
			it('rejects the response promise when async handler throws before writing headers', async function () {
				const request = makeRequest();
				const err = new Error('async handler failed');
				const responsePromise = request.withNodeAdapter(async (_req, _res) => {
					throw err;
				});

				await assert.rejects(() => responsePromise, /async handler failed/);
			});

			it('does not double-reject after headers are flushed when async handler throws', async function () {
				const request = makeRequest();
				const responsePromise = request.withNodeAdapter(async (req, res) => {
					res.end('body');
					throw new Error('late async throw');
				});

				const { status } = await responsePromise;
				assert.strictEqual(status, 200);
			});
		});
	});

	describe('Headers class', function () {
		let headers;

		beforeEach(function () {
			const mockNodeRequest = {
				method: 'GET',
				url: '/test',
				headers: {
					'content-type': 'application/json',
					'x-custom-header': 'value',
					'authorization': 'Bearer token',
				},
				socket: {
					encrypted: true,
					getPeerCertificate: sinon.stub().returns({}),
				},
			};

			const request = new Request(mockNodeRequest, {});
			headers = request.headers;
		});

		it('should get headers case-insensitively', function () {
			// Headers are stored with their original case, but accessed case-insensitively
			assert.strictEqual(headers.get('content-type'), 'application/json');
			assert.strictEqual(headers.get('Content-Type'), 'application/json');
			assert.strictEqual(headers.get('CONTENT-TYPE'), 'application/json');
			assert.strictEqual(headers.get('x-custom-header'), 'value');
		});

		it('should set headers case-insensitively', function () {
			headers.set('X-New-Header', 'new value');
			assert.strictEqual(headers.get('x-new-header'), 'new value');

			headers.set('content-type', 'text/plain');
			assert.strictEqual(headers.get('Content-Type'), 'text/plain');
		});

		it('should check header existence case-insensitively', function () {
			assert(headers.has('content-type'));
			assert(headers.has('Content-Type'));
			assert(headers.has('AUTHORIZATION'));
			assert(!headers.has('non-existent'));
		});

		it('should delete headers case-insensitively', function () {
			headers.delete('Content-Type');
			assert(!headers.has('content-type'));
			assert.strictEqual(headers.get('content-type'), undefined);
		});

		it('should iterate over headers', function () {
			const entries = [];
			for (const [key, value] of headers) {
				entries.push([key, value]);
			}

			assert.deepStrictEqual(entries, [
				['content-type', 'application/json'],
				['x-custom-header', 'value'],
				['authorization', 'Bearer token'],
			]);
		});

		it('should return header keys', function () {
			const keys = headers.keys();
			assert.deepStrictEqual(keys, ['content-type', 'x-custom-header', 'authorization']);
		});

		it('should return header values', function () {
			const values = headers.values();
			assert.deepStrictEqual(values, ['application/json', 'value', 'Bearer token']);
		});

		it('should iterate with forEach', function () {
			const collected = [];
			headers.forEach((value, key, obj) => {
				collected.push({ key, value });
				assert.strictEqual(obj, headers);
			});

			assert.deepStrictEqual(collected, [
				{ key: 'content-type', value: 'application/json' },
				{ key: 'x-custom-header', value: 'value' },
				{ key: 'authorization', value: 'Bearer token' },
			]);
		});
	});
});
