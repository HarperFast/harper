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
			// Currently always returns false (TODO in implementation)
			assert.strictEqual(request.isAborted, false);
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

	describe('getNodeRequestResponse', function () {
		let mockNodeRequest;

		beforeEach(function () {
			mockNodeRequest = {
				method: 'GET',
				url: '/original',
				headers: { host: 'example.com', 'content-type': 'text/plain' },
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

		describe('nodeRequest', function () {
			it('reflects current method and url', function () {
				const request = makeRequest();
				request.method = 'POST';
				request.url = '/modified';

				const { nodeRequest } = request.getNodeRequestResponse();

				assert.strictEqual(nodeRequest.method, 'POST');
				assert.strictEqual(nodeRequest.url, '/modified');
			});

			it('reflects middleware-mutated headers', function () {
				const request = makeRequest();
				request.headers.set('x-custom', 'added');

				const { nodeRequest } = request.getNodeRequestResponse();

				assert.strictEqual(nodeRequest.headers['x-custom'], 'added');
				assert.strictEqual(nodeRequest.headers['content-type'], 'text/plain');
			});

			it('has lowercase header keys', function () {
				const request = makeRequest({
					headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
				});

				const { nodeRequest } = request.getNodeRequestResponse();

				assert.ok('content-type' in nodeRequest.headers);
				assert.ok('authorization' in nodeRequest.headers);
				assert.strictEqual(nodeRequest.headers['content-type'], 'application/json');
			});

			it('delegates socket to the underlying IncomingMessage socket', function () {
				const request = makeRequest();
				const { nodeRequest } = request.getNodeRequestResponse();
				assert.strictEqual(nodeRequest.socket, mockNodeRequest.socket);
			});
		});

		describe('nodeResponse — writeHead', function () {
			it('resolves response with correct status and headers', async function () {
				const request = makeRequest();
				const { nodeResponse, response } = request.getNodeRequestResponse();

				nodeResponse.writeHead(201, { 'content-type': 'application/json' });
				nodeResponse.end();

				const resolved = await response;
				assert.strictEqual(resolved.status, 201);
				assert.strictEqual(resolved.headers.get('content-type'), 'application/json');
			});

			it('is idempotent — second writeHead call is a no-op', async function () {
				const request = makeRequest();
				const { nodeResponse, response } = request.getNodeRequestResponse();

				nodeResponse.writeHead(200, { 'x-first': 'yes' });
				nodeResponse.writeHead(500, { 'x-first': 'overwritten' });
				nodeResponse.end();

				const { status, headers } = await response;
				assert.strictEqual(status, 200);
				assert.strictEqual(headers.get('x-first'), 'yes');
			});

			it('accepts array-of-pairs header format', async function () {
				const request = makeRequest();
				const { nodeResponse, response } = request.getNodeRequestResponse();

				nodeResponse.writeHead(200, [['x-pair', 'value']]);
				nodeResponse.end();

				const { headers } = await response;
				assert.strictEqual(headers.get('x-pair'), 'value');
			});

			it('sets headersSent after writeHead', function () {
				const request = makeRequest();
				const { nodeResponse } = request.getNodeRequestResponse();

				assert.strictEqual(nodeResponse.headersSent, false);
				nodeResponse.writeHead(200);
				assert.strictEqual(nodeResponse.headersSent, true);
			});
		});

		describe('nodeResponse — setHeader / end path', function () {
			it('resolves response with headers set before end()', async function () {
				const request = makeRequest();
				const { nodeResponse, response } = request.getNodeRequestResponse();

				nodeResponse.setHeader('content-type', 'text/html');
				nodeResponse.end('<h1>hi</h1>');

				const { status, headers } = await response;
				assert.strictEqual(status, 200);
				assert.strictEqual(headers.get('content-type'), 'text/html');
			});

			it('captures statusCode set directly', async function () {
				const request = makeRequest();
				const { nodeResponse, response } = request.getNodeRequestResponse();

				nodeResponse.statusCode = 404;
				nodeResponse.end();

				const { status } = await response;
				assert.strictEqual(status, 404);
			});

			it('getHeader / hasHeader / removeHeader work', function () {
				const request = makeRequest();
				const { nodeResponse } = request.getNodeRequestResponse();

				nodeResponse.setHeader('x-test', 'abc');
				assert.strictEqual(nodeResponse.getHeader('x-test'), 'abc');
				assert.ok(nodeResponse.hasHeader('x-test'));

				nodeResponse.removeHeader('x-test');
				assert.ok(!nodeResponse.hasHeader('x-test'));
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
				const { nodeResponse, response } = request.getNodeRequestResponse();

				nodeResponse.end('hello world');

				const { body } = await response;
				assert.strictEqual(await collectBody(body), 'hello world');
			});

			it('multiple write() calls are streamed in order', async function () {
				const request = makeRequest();
				const { nodeResponse, response } = request.getNodeRequestResponse();

				nodeResponse.write('chunk1');
				nodeResponse.write('chunk2');
				nodeResponse.end('chunk3');

				const { body } = await response;
				assert.strictEqual(await collectBody(body), 'chunk1chunk2chunk3');
			});

			it('end() with no body yields an empty body', async function () {
				const request = makeRequest();
				const { nodeResponse, response } = request.getNodeRequestResponse();

				nodeResponse.end();

				const { body } = await response;
				assert.strictEqual(await collectBody(body), '');
			});

			it('sets writableEnded after end()', async function () {
				const request = makeRequest();
				const { nodeResponse, response } = request.getNodeRequestResponse();

				assert.strictEqual(nodeResponse.writableEnded, false);
				nodeResponse.end();
				assert.strictEqual(nodeResponse.writableEnded, true);

				await response;
			});

			it('emits finish event after body is fully written', async function () {
				const request = makeRequest();
				const { nodeResponse, response } = request.getNodeRequestResponse();

				const finishSpy = sinon.spy();
				nodeResponse.on('finish', finishSpy);

				nodeResponse.end('done');
				await response;

				// Wait for finish to propagate through the PassThrough
				await new Promise((resolve) => setImmediate(resolve));
				assert.ok(finishSpy.calledOnce);
			});
		});

		describe('nodeResponse — destroy', function () {
			it('rejects the response promise with the provided error', async function () {
				const request = makeRequest();
				const { nodeResponse, response } = request.getNodeRequestResponse();

				const err = new Error('stream destroyed');
				nodeResponse.destroy(err);

				await assert.rejects(() => response, /stream destroyed/);
			});

			it('does not reject if destroy called after headers already flushed', async function () {
				const request = makeRequest();
				const { nodeResponse, response } = request.getNodeRequestResponse();

				nodeResponse.end('body');
				await response; // resolve first

				// Should not throw
				nodeResponse.destroy(new Error('late destroy'));
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
