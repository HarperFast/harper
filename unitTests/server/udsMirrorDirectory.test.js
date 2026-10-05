'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const env = require('#src/utility/environment/environmentManager');
const { ensureSocketsDirectory, writeUdsMetadata } = require('#src/server/http');

// Kept out of udsMirror.test.js, which the Windows gate excludes.
const POSIX = process.platform !== 'win32';
const posixIt = POSIX ? it : it.skip;
const posixNonRootIt = POSIX && process.getuid?.() !== 0 ? it : it.skip;

function modeOf(filePath) {
	return fs.statSync(filePath).mode & 0o777;
}

function makeSecureServer() {
	return { secureContexts: new Map() };
}

describe('UDS mirror directory and metadata publication', () => {
	let workDir;

	before(() => {
		fs.mkdirSync(testUtils.ENV_DIR_PATH, { recursive: true });
		workDir = fs.mkdtempSync(path.join(testUtils.ENV_DIR_PATH, 'uds-dir-'));
	});

	after(() => {
		if (workDir) testUtils.cleanUpDirectories(workDir);
	});

	describe('ensureSocketsDirectory', () => {
		// Read at test time: other suites in the same mocha process re-point the base path.
		let SOCKETS_DIR;

		beforeEach(() => {
			SOCKETS_DIR = path.join(env.getHdbBasePath(), 'sockets');
			fs.rmSync(SOCKETS_DIR, { recursive: true, force: true });
		});

		afterEach(() => {
			fs.rmSync(SOCKETS_DIR, { recursive: true, force: true });
		});

		posixIt('creates a missing directory with mode 0700', () => {
			assert.strictEqual(ensureSocketsDirectory(), SOCKETS_DIR);
			assert.strictEqual(modeOf(SOCKETS_DIR), 0o700);
		});

		posixIt('tightens a pre-created 0755 directory to 0700', () => {
			fs.mkdirSync(SOCKETS_DIR);
			fs.chmodSync(SOCKETS_DIR, 0o755);
			assert.strictEqual(ensureSocketsDirectory(), SOCKETS_DIR);
			assert.strictEqual(modeOf(SOCKETS_DIR), 0o700);
		});

		posixIt('restores owner access to an owner-unusable directory', () => {
			fs.mkdirSync(SOCKETS_DIR);
			fs.chmodSync(SOCKETS_DIR, 0o500);
			assert.strictEqual(ensureSocketsDirectory(), SOCKETS_DIR);
			assert.strictEqual(modeOf(SOCKETS_DIR), 0o700);
		});

		it('is idempotent on an existing directory', () => {
			assert.strictEqual(ensureSocketsDirectory(), SOCKETS_DIR);
			assert.strictEqual(ensureSocketsDirectory(), SOCKETS_DIR);
			assert.ok(fs.statSync(SOCKETS_DIR).isDirectory());
		});

		it('returns undefined and leaves the path alone when a regular file occupies it', () => {
			fs.writeFileSync(SOCKETS_DIR, 'not a directory');
			assert.strictEqual(ensureSocketsDirectory(), undefined);
			assert.strictEqual(fs.readFileSync(SOCKETS_DIR, 'utf8'), 'not a directory');
		});
	});

	describe('writeUdsMetadata publication', () => {
		let socketsDir;
		let yamlPath;

		beforeEach(() => {
			socketsDir = fs.mkdtempSync(path.join(workDir, 'publish-'));
			yamlPath = path.join(socketsDir, '0-9926.yaml');
		});

		afterEach(() => {
			if (socketsDir) testUtils.cleanUpDirectories(socketsDir);
		});

		function tempFilesIn(dir) {
			return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
		}

		it('publishes a complete yaml and leaves no temp file behind', () => {
			writeUdsMetadata(yamlPath, 9926, makeSecureServer());
			assert.match(fs.readFileSync(yamlPath, 'utf8'), /^port: 9926$/m);
			assert.deepStrictEqual(tempFilesIn(socketsDir), []);
		});

		posixIt('replaces the yaml by rename rather than an in-place write', () => {
			writeUdsMetadata(yamlPath, 9926, makeSecureServer());
			const inodeBefore = fs.statSync(yamlPath).ino;
			writeUdsMetadata(yamlPath, 9927, makeSecureServer());
			assert.notStrictEqual(fs.statSync(yamlPath).ino, inodeBefore);
			assert.match(fs.readFileSync(yamlPath, 'utf8'), /^port: 9927$/m);
		});

		posixIt('keeps an open descriptor on the previous complete generation', () => {
			writeUdsMetadata(yamlPath, 9926, makeSecureServer());
			const previous = fs.readFileSync(yamlPath);
			const fd = fs.openSync(yamlPath, 'r');
			try {
				writeUdsMetadata(yamlPath, 9927, makeSecureServer());
				const seen = Buffer.alloc(previous.length);
				fs.readSync(fd, seen, 0, seen.length, 0);
				assert.strictEqual(seen.toString(), previous.toString());
			} finally {
				fs.closeSync(fd);
			}
		});

		posixNonRootIt('keeps the previous yaml when the temp file cannot be written', () => {
			writeUdsMetadata(yamlPath, 9926, makeSecureServer());
			const previous = fs.readFileSync(yamlPath, 'utf8');
			fs.chmodSync(socketsDir, 0o500);
			try {
				assert.doesNotThrow(() => writeUdsMetadata(yamlPath, 9927, makeSecureServer()));
			} finally {
				fs.chmodSync(socketsDir, 0o700);
			}
			assert.strictEqual(fs.readFileSync(yamlPath, 'utf8'), previous);
			assert.deepStrictEqual(tempFilesIn(socketsDir), []);
		});

		it('does not throw and leaves no temp file when the rename target is a non-empty directory', () => {
			fs.mkdirSync(yamlPath);
			fs.writeFileSync(path.join(yamlPath, 'blocker'), '');
			assert.doesNotThrow(() => writeUdsMetadata(yamlPath, 9926, makeSecureServer()));
			assert.ok(fs.statSync(yamlPath).isDirectory());
			assert.deepStrictEqual(tempFilesIn(socketsDir), []);
		});
	});
});
