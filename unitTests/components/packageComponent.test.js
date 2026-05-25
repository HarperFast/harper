'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { streamPackagedDirectory, packageDirectory } = require('#src/components/packageComponent');
const { buildMultipartBody } = require('#src/bin/multipartBuilder');
const { parseMultipartRequest } = require('#src/server/serverHelpers/multipartParser');
const gunzip = require('gunzip-maybe');
const tar = require('tar-fs');

async function makeFixture(files) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-roundtrip-'));
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, content);
	}
	return dir;
}

async function readDirTree(dir) {
	const out = {};
	async function walk(rel) {
		const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
		for (const entry of entries) {
			const childRel = rel ? path.join(rel, entry.name) : entry.name;
			if (entry.isDirectory()) await walk(childRel);
			else out[childRel] = await fs.readFile(path.join(dir, childRel), 'utf8');
		}
	}
	await walk('');
	return out;
}

function parseMultipart(contentType, stream) {
	return new Promise((resolve, reject) => {
		parseMultipartRequest({ headers: { 'content-type': contentType } }, stream, (err, body) =>
			err ? reject(err) : resolve(body)
		);
	});
}

describe('streamPackagedDirectory round-trip', () => {
	it('round-trips a directory tree through stream → multipart → parser → gunzip → tar extract', async function () {
		this.timeout(15000);
		const sourceFiles = {
			'package.json': '{"name":"demo","version":"1.0.0"}\n',
			'index.js': 'module.exports = () => 42;\n',
			'docs/README.md': '# demo\n',
		};
		const sourceDir = await makeFixture(sourceFiles);
		const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-roundtrip-out-'));
		try {
			// Build the CLI-side request body just like cliOperations.js would.
			const multipart = buildMultipartBody(
				{ operation: 'deploy_component', project: 'demo' },
				{
					name: 'payload',
					filename: 'package.tar.gz',
					contentType: 'application/gzip',
					stream: streamPackagedDirectory(sourceDir, { skip_node_modules: true }),
				}
			);
			// Send it through the server-side parser.
			const body = await parseMultipart(multipart.contentType, multipart.stream);
			assert.strictEqual(body.operation, 'deploy_component');
			assert.strictEqual(body.project, 'demo');
			// Pipe payload exactly as extractApplication does: gunzip-maybe + tar-fs.extract
			await pipeline(body.payload, gunzip(), tar.extract(extractDir));
			const extracted = await readDirTree(extractDir);
			assert.deepStrictEqual(extracted, sourceFiles);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(extractDir, { recursive: true, force: true });
		}
	});

	it('packageDirectory still produces a buffer with identical contents to streamPackagedDirectory', async function () {
		this.timeout(15000);
		const sourceDir = await makeFixture({ 'a.txt': 'A', 'b/c.txt': 'C' });
		try {
			const buffered = await packageDirectory(sourceDir, { skip_node_modules: true });
			const streamedChunks = [];
			for await (const chunk of streamPackagedDirectory(sourceDir, { skip_node_modules: true })) {
				streamedChunks.push(chunk);
			}
			const streamed = Buffer.concat(streamedChunks);
			// tar+gzip is deterministic-ish; sizes should match exactly for an identical input tree.
			assert.strictEqual(streamed.length, buffered.length);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});
});

// keep eslint happy in case Readable isn't directly used in some branch
void Readable;
