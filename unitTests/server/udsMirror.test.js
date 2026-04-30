'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');
const path = require('path');
const fs = require('fs');

const env = require('#js/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const {
	writeUdsMetadata,
	registerUdsCleanupPaths,
	cleanupUdsFiles,
	cleanupSocketsDirectory,
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
			const harperLogger = require('#js/utility/logging/harper_logger');
			const errorStub = sandbox.stub(harperLogger, 'error');
			// Use an invalid path that cannot be written
			writeUdsMetadata('/nonexistent-dir/missing/0-9926.yaml', 9926, makeSecureServer());
			assert.ok(errorStub.calledOnce, 'should log the write error');
			assert.ok(errorStub.firstCall.args[0].includes('Error writing UDS metadata'));
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
});
