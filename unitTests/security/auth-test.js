const assert = require('node:assert/strict');
const sinon = require('sinon');

// First set up test environment
const test_utils = require('../test_utils');
test_utils.preTestPrep();

describe('auth.ts - certificate verification integration', function() {
	let sandbox;
	let certificateVerificationStub;
	let authModule;
	let getUserStub;
	let envStub;
	let authEventLogStub;
	
	before(function() {
		sandbox = sinon.createSandbox();
		
		// Stub certificate verification before loading auth module
		certificateVerificationStub = sandbox.stub();
		const certificateVerification = require('../../security/certificateVerification.ts');
		sandbox.stub(certificateVerification, 'verifyCertificate').callsFake(certificateVerificationStub);
		
		// Stub server getUser method
		const serverModule = require('../../server/Server.ts');
		getUserStub = sandbox.stub();
		sandbox.stub(serverModule.server, 'getUser').callsFake(getUserStub);
		
		// Stub serializeMessage
		const contentTypes = require('../../server/serverHelpers/contentTypes.ts');
		sandbox.stub(contentTypes, 'serializeMessage').returnsArg(0);
		
		// Stub env to ensure auth is loaded with correct settings
		const env = require('../../utility/environment/environmentManager.js');
		envStub = sandbox.stub(env, 'get');
		envStub.withArgs('authentication.enableSessions').returns(false); // Disable sessions for simpler testing
		envStub.withArgs('authentication.authorizeLocal').returns(false);
		envStub.withArgs('logging.auditAuthEvents.logSuccessful').returns(true);
		envStub.withArgs('logging.auditAuthEvents.logFailed').returns(true);
		envStub.returns(undefined); // Default for other values
		
		// Stub the auth event logger
		const harperLogger = require('../../utility/logging/harper_logger.js');
		authEventLogStub = {
			error: sandbox.stub(),
			notify: sandbox.stub()
		};
		sandbox.stub(harperLogger, 'forComponent').returns({
			withTag: sandbox.stub().returns(authEventLogStub),
			debug: sandbox.stub()
		});
		
		// Now load auth module after stubs are in place
		authModule = require('../../security/auth.ts');
	});
	
	after(function() {
		sandbox.restore();
	});
	
	beforeEach(function() {
		sandbox.resetHistory();
	});
	
	describe('mTLS certificate verification in authentication middleware', function() {
		let request, nextHandler, response;
		
		beforeEach(function() {
			request = {
				headers: {
					asObject: {
						authorization: null,
						cookie: null,
						origin: null,
						host: 'localhost'
					}
				},
				method: 'GET',
				pathname: '/test',
				ip: '192.168.1.100', // eslint-disable-line sonarjs/no-hardcoded-ip
				isOperationsServer: false,
				mtlsConfig: null,
				authorized: false,
				peerCertificate: null,
				protocol: 'https'
			};
			
			response = {
				status: 200,
				headers: {
					set: sandbox.stub()
				},
				body: {}
			};
			
			nextHandler = sandbox.stub().resolves(response);
		});
		
		it('should skip certificate verification when mTLS is not configured', async function() {
			request.mtlsConfig = null;
			request.authorized = false;
			
			const result = await authModule.authentication(request, nextHandler);
			
			assert(!certificateVerificationStub.called);
			assert(nextHandler.calledOnce);
			assert.strictEqual(result.status, 200);
		});
		
		it('should skip certificate verification when not authorized by TLS', async function() {
			request.mtlsConfig = { user: 'CN' };
			request.authorized = false;
			request.peerCertificate = { subject: null }; // auth.ts checks peerCertificate.subject
			
			const result = await authModule.authentication(request, nextHandler);
			
			assert(!certificateVerificationStub.called);
			assert(nextHandler.calledOnce);
			assert.strictEqual(result.status, 200);
		});
		
		it('should verify certificate when mTLS is configured and authorized', async function() {
			request.mtlsConfig = { user: 'CN' };
			request.authorized = true;
			request.peerCertificate = {
				subject: {
					CN: 'test-client'
				}
			};
			
			certificateVerificationStub.resolves({
				valid: true,
				status: 'good'
			});
			
			getUserStub.resolves({ username: 'test-client', active: true });
			
			const result = await authModule.authentication(request, nextHandler);
			
			assert(certificateVerificationStub.calledOnce);
			assert(certificateVerificationStub.calledWith(request.peerCertificate, request.mtlsConfig));
			assert(getUserStub.calledWith('test-client', null, request));
			assert.strictEqual(request.user.username, 'test-client');
			assert(nextHandler.calledOnce);
			assert.strictEqual(result.status, 200);
		});
		
		it('should reject request when certificate is revoked', async function() {
			request.mtlsConfig = { user: 'CN' };
			request.authorized = true;
			request.peerCertificate = {
				subject: {
					CN: 'revoked-client'
				}
			};
			
			certificateVerificationStub.resolves({
				valid: false,
				status: 'revoked'
			});
			
			const result = await authModule.authentication(request, nextHandler);
			
			assert(certificateVerificationStub.calledOnce);
			assert(!getUserStub.called);
			assert(!nextHandler.called);
			assert.strictEqual(result.status, 401);
			assert.deepStrictEqual(result.body, { error: 'Certificate revoked or verification failed' });
		});
		
		it('should reject request when certificate verification fails', async function() {
			request.mtlsConfig = { user: 'CN' };
			request.authorized = true;
			request.peerCertificate = {
				subject: {
					CN: 'unknown-client'
				}
			};
			
			certificateVerificationStub.resolves({
				valid: false,
				status: 'unknown'
			});
			
			const result = await authModule.authentication(request, nextHandler);
			
			assert(certificateVerificationStub.calledOnce);
			assert(!getUserStub.called);
			assert(!nextHandler.called);
			assert.strictEqual(result.status, 401);
		});
		
		it('should handle mTLS with custom user field', async function() {
			request.mtlsConfig = { user: 'custom-username' };
			request.authorized = true;
			request.peerCertificate = {
				subject: {
					CN: 'test-client'
				}
			};
			
			certificateVerificationStub.resolves({
				valid: true,
				status: 'good'
			});
			
			getUserStub.resolves({ username: 'custom-username', active: true });
			
			await authModule.authentication(request, nextHandler);
			
			assert(certificateVerificationStub.calledOnce);
			assert(getUserStub.calledWith('custom-username', null, request));
			assert.strictEqual(request.user.username, 'custom-username');
			assert(nextHandler.calledOnce);
		});
		
		it('should handle mTLS with null user (no user mapping)', async function() {
			request.mtlsConfig = { user: null };
			request.authorized = true;
			request.peerCertificate = {
				subject: {
					CN: 'test-client'
				}
			};
			
			certificateVerificationStub.resolves({
				valid: true,
				status: 'good'
			});
			
			await authModule.authentication(request, nextHandler);
			
			assert(certificateVerificationStub.calledOnce);
			assert(!getUserStub.called);
			assert.strictEqual(request.user, undefined);
			assert(nextHandler.calledOnce);
		});
		
		it('should use Common Name when user is set to CN', async function() {
			request.mtlsConfig = { user: 'CN' };
			request.authorized = true;
			request.peerCertificate = {
				subject: {
					CN: 'common-name-client'
				}
			};
			
			certificateVerificationStub.resolves({
				valid: true,
				status: 'good'
			});
			
			getUserStub.resolves({ username: 'common-name-client', active: true });
			
			await authModule.authentication(request, nextHandler);
			
			assert(getUserStub.calledWith('common-name-client', null, request));
			assert.strictEqual(request.user.username, 'common-name-client');
		});
		
		it('should handle certificate verification with different statuses', async function() {
			request.mtlsConfig = { user: 'CN' };
			request.authorized = true;
			request.peerCertificate = {
				subject: {
					CN: 'test-client'
				}
			};
			
			// Test with error-allowed status
			certificateVerificationStub.resolves({
				valid: true,
				status: 'error-allowed'
			});
			
			getUserStub.resolves({ username: 'test-client', active: true });
			
			const result = await authModule.authentication(request, nextHandler);
			
			assert(certificateVerificationStub.calledOnce);
			assert(getUserStub.calledOnce);
			assert(nextHandler.calledOnce);
			assert.strictEqual(result.status, 200);
		});
		
		it('should pass mtlsConfig to verifyCertificate for configuration', async function() {
			const mtlsConfig = {
				user: 'CN',
				certificateVerification: {
					timeout: 10000,
					cacheTtl: 7200000,
					failureMode: 'fail-closed'
				}
			};
			
			request.mtlsConfig = mtlsConfig;
			request.authorized = true;
			request.peerCertificate = {
				subject: {
					CN: 'test-client'
				}
			};
			
			certificateVerificationStub.resolves({
				valid: true,
				status: 'good'
			});
			
			getUserStub.resolves({ username: 'test-client', active: true });
			
			await authModule.authentication(request, nextHandler);
			
			assert(certificateVerificationStub.calledWith(request.peerCertificate, mtlsConfig));
			// Verify the exact config object was passed
			const [, passedConfig] = certificateVerificationStub.firstCall.args;
			assert.deepStrictEqual(passedConfig, mtlsConfig);
		});
	});
	
	describe('authentication error logging', function() {
		let request, nextHandler;
		
		beforeEach(function() {
			request = {
				headers: {
					asObject: {
						authorization: null,
						cookie: null,
						origin: null,
						host: 'localhost'
					}
				},
				method: 'GET',
				pathname: '/test',
				ip: '192.168.1.100', // eslint-disable-line sonarjs/no-hardcoded-ip
				isOperationsServer: false,
				mtlsConfig: { user: 'CN' },
				authorized: true,
				peerCertificate: {
					subject: {
						CN: 'test-client'
					}
				},
				protocol: 'https'
			};
			
			nextHandler = sandbox.stub().resolves({
				status: 200,
				headers: {
					set: sandbox.stub()
				}
			});
		});
		
		it('should log certificate verification failures', async function() {
			certificateVerificationStub.resolves({
				valid: false,
				status: 'revoked'
			});
			
			await authModule.authentication(request, nextHandler);
			
			assert(authEventLogStub.error.called);
			const errorCall = authEventLogStub.error.firstCall;
			assert(errorCall.args[0].includes('Certificate verification failed'));
			assert(errorCall.args[1] === 'revoked');
		});
	});
});