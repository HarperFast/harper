'use strict';

const assert = require('node:assert/strict');
const sinon = require('sinon');

describe('Request class', function() {
	let Request;
	
	before(function() {
		// Clear the module from cache to ensure fresh load
		const modulePath = require.resolve('../../../server/serverHelpers/Request.ts');
		delete require.cache[modulePath];
		Request = require('../../../server/serverHelpers/Request.ts').Request;
	});
	
	afterEach(function() {
		sinon.restore();
	});
	
	describe('peerCertificate getter', function() {
		it('should call getPeerCertificate with true to get full certificate chain', function() {
			// Create a mock socket with getPeerCertificate method
			const mockCertificate = {
				subject: { CN: 'test-client' },
				issuer: { CN: 'test-ca' },
				raw: Buffer.from('mock-cert'),
				issuerCertificate: {
					subject: { CN: 'test-ca' },
					issuer: { CN: 'test-ca' },
					raw: Buffer.from('mock-ca-cert')
				}
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
					server: { mtlsConfig: {} }
				}
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
		
		it('should handle empty certificate object', function() {
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
					server: {}
				}
			};
			
			const mockNodeResponse = {};
			
			const request = new Request(mockNodeRequest, mockNodeResponse);
			const cert = request.peerCertificate;
			
			assert(getPeerCertificateStub.calledOnce);
			assert(getPeerCertificateStub.calledWith(true));
			assert.deepStrictEqual(cert, {});
		});
		
		it('should ensure certificate chain is available for OCSP verification', function() {
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
						issuerCertificate: null // Self-signed
					}
				}
			};
			
			const getPeerCertificateStub = sinon.stub();
			getPeerCertificateStub.withArgs(true).returns(fullChainCert);
			getPeerCertificateStub.withArgs(false).returns({
				subject: { CN: 'client.example.com' },
				issuer: { CN: 'Intermediate CA' },
				raw: Buffer.from('client-cert'),
				serialNumber: '123456'
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
					server: { mtlsConfig: {} }
				}
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
	
	describe('other getters', function() {
		let mockNodeRequest, mockNodeResponse, request;
		
		beforeEach(function() {
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
					getPeerCertificate: sinon.stub().returns({})
				}
			};
			
			mockNodeResponse = {};
			request = new Request(mockNodeRequest, mockNodeResponse);
		});
		
		it('should return correct protocol based on socket encryption', function() {
			assert.strictEqual(request.protocol, 'https');
			
			mockNodeRequest.socket.encrypted = false;
			assert.strictEqual(request.protocol, 'http');
		});
		
		it('should return correct IP address', function() {
			assert.strictEqual(request.ip, '192.168.1.100');
		});
		
		it('should return authorized status', function() {
			assert.strictEqual(request.authorized, true);
			
			mockNodeRequest.socket.authorized = false;
			assert.strictEqual(request.authorized, false);
		});
		
		it('should return mtlsConfig from server', function() {
			assert.deepStrictEqual(request.mtlsConfig, { user: 'CN' });
		});
		
		it('should return correct pathname', function() {
			assert.strictEqual(request.pathname, '/api/test');
			
			request.url = '/simple/path';
			assert.strictEqual(request.pathname, '/simple/path');
		});
		
		it('should return correct host', function() {
			assert.strictEqual(request.host, 'example.com:443');
			
			delete mockNodeRequest.authority;
			assert.strictEqual(request.host, 'example.com');
		});
		
		it('should return correct absoluteURL', function() {
			assert.strictEqual(request.absoluteURL, 'https://example.com:443/api/test?param=value');
			
			mockNodeRequest.socket.encrypted = false;
			assert.strictEqual(request.absoluteURL, 'http://example.com:443/api/test?param=value');
		});
		
		it('should handle pathname setter', function() {
			request.pathname = '/new/path';
			assert.strictEqual(request.url, '/new/path?param=value');
			assert.strictEqual(request.pathname, '/new/path');
			
			// Test without query string
			request.url = '/simple';
			request.pathname = '/updated';
			assert.strictEqual(request.url, '/updated');
		});
		
		it('should return httpVersion', function() {
			assert.strictEqual(request.httpVersion, '1.1');
		});
		
		it('should return isAborted status', function() {
			// Currently always returns false (TODO in implementation)
			assert.strictEqual(request.isAborted, false);
		});
	});
	
	describe('body getter', function() {
		it('should create RequestBody instance lazily', function() {
			const mockNodeRequest = {
				method: 'POST',
				url: '/test',
				headers: {},
				socket: {
					encrypted: true,
					getPeerCertificate: sinon.stub().returns({})
				},
				on: sinon.stub(),
				pipe: sinon.stub()
			};
			
			const request = new Request(mockNodeRequest, {});
			
			// First access creates the body
			const body1 = request.body;
			// Second access returns the same instance
			const body2 = request.body;
			
			assert.strictEqual(body1, body2);
		});
		
		it('should proxy event handling to node request', function() {
			const onStub = sinon.stub();
			const mockNodeRequest = {
				method: 'POST',
				url: '/test',
				headers: {},
				socket: {
					encrypted: true,
					getPeerCertificate: sinon.stub().returns({})
				},
				on: onStub
			};
			
			const request = new Request(mockNodeRequest, {});
			const body = request.body;
			const listener = () => {};
			
			const result = body.on('data', listener);
			
			assert(onStub.calledOnce);
			assert(onStub.calledWith('data', listener));
			assert.strictEqual(result, body); // Should return this for chaining
		});
		
		it('should proxy pipe to node request', function() {
			const pipeStub = sinon.stub().returns('piped');
			const mockNodeRequest = {
				method: 'POST',
				url: '/test',
				headers: {},
				socket: {
					encrypted: true,
					getPeerCertificate: sinon.stub().returns({})
				},
				pipe: pipeStub
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
	
	describe('sendEarlyHints method', function() {
		it('should send early hints with link header', function() {
			const writeEarlyHintsStub = sinon.stub();
			const mockNodeRequest = {
				method: 'GET',
				url: '/test',
				headers: {},
				socket: {
					encrypted: true,
					getPeerCertificate: sinon.stub().returns({})
				}
			};
			const mockNodeResponse = {
				writeEarlyHints: writeEarlyHintsStub
			};
			
			const request = new Request(mockNodeRequest, mockNodeResponse);
			
			request.sendEarlyHints('</styles.css>; rel=preload; as=style');
			
			assert(writeEarlyHintsStub.calledOnce);
			assert.deepStrictEqual(writeEarlyHintsStub.firstCall.args[0], {
				link: '</styles.css>; rel=preload; as=style'
			});
		});
		
		it('should merge link with additional headers', function() {
			const writeEarlyHintsStub = sinon.stub();
			const mockNodeResponse = {
				writeEarlyHints: writeEarlyHintsStub
			};
			
			const request = new Request({
				method: 'GET',
				url: '/test',
				headers: {},
				socket: {
					encrypted: true,
					getPeerCertificate: sinon.stub().returns({})
				}
			}, mockNodeResponse);
			
			const additionalHeaders = { 'x-custom': 'value' };
			request.sendEarlyHints('</script.js>; rel=preload; as=script', additionalHeaders);
			
			assert(writeEarlyHintsStub.calledOnce);
			assert.deepStrictEqual(writeEarlyHintsStub.firstCall.args[0], {
				link: '</script.js>; rel=preload; as=script',
				'x-custom': 'value'
			});
		});
	});
	
	describe('Headers class', function() {
		let headers;
		
		beforeEach(function() {
			const mockNodeRequest = {
				method: 'GET',
				url: '/test',
				headers: {
					'content-type': 'application/json',
					'x-custom-header': 'value',
					'authorization': 'Bearer token'
				},
				socket: {
					encrypted: true,
					getPeerCertificate: sinon.stub().returns({})
				}
			};
			
			const request = new Request(mockNodeRequest, {});
			headers = request.headers;
		});
		
		it('should get headers case-insensitively', function() {
			// Headers are stored with their original case, but accessed case-insensitively
			assert.strictEqual(headers.get('content-type'), 'application/json');
			assert.strictEqual(headers.get('Content-Type'), 'application/json');
			assert.strictEqual(headers.get('CONTENT-TYPE'), 'application/json');
			assert.strictEqual(headers.get('x-custom-header'), 'value');
		});
		
		it('should set headers case-insensitively', function() {
			headers.set('X-New-Header', 'new value');
			assert.strictEqual(headers.get('x-new-header'), 'new value');
			
			headers.set('content-type', 'text/plain');
			assert.strictEqual(headers.get('Content-Type'), 'text/plain');
		});
		
		it('should check header existence case-insensitively', function() {
			assert(headers.has('content-type'));
			assert(headers.has('Content-Type'));
			assert(headers.has('AUTHORIZATION'));
			assert(!headers.has('non-existent'));
		});
		
		it('should delete headers case-insensitively', function() {
			headers.delete('Content-Type');
			assert(!headers.has('content-type'));
			assert.strictEqual(headers.get('content-type'), undefined);
		});
		
		it('should iterate over headers', function() {
			const entries = [];
			for (const [key, value] of headers) {
				entries.push([key, value]);
			}
			
			assert.deepStrictEqual(entries, [
				['content-type', 'application/json'],
				['x-custom-header', 'value'],
				['authorization', 'Bearer token']
			]);
		});
		
		it('should return header keys', function() {
			const keys = headers.keys();
			assert.deepStrictEqual(keys, ['content-type', 'x-custom-header', 'authorization']);
		});
		
		it('should return header values', function() {
			const values = headers.values();
			assert.deepStrictEqual(values, ['application/json', 'value', 'Bearer token']);
		});
		
		it('should iterate with forEach', function() {
			const collected = [];
			headers.forEach((value, key, obj) => {
				collected.push({ key, value });
				assert.strictEqual(obj, headers);
			});
			
			assert.deepStrictEqual(collected, [
				{ key: 'content-type', value: 'application/json' },
				{ key: 'x-custom-header', value: 'value' },
				{ key: 'authorization', value: 'Bearer token' }
			]);
		});
	});
});