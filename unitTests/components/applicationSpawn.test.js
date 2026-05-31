'use strict';

// Verifies the line-buffered `onLine` callback added to
// `nonInteractiveSpawn`. The spawn function buffers stdout/stderr by newline so a
// chunk that splits mid-line never fires a partial line; trailing fragments are
// flushed on process close. These tests drive that contract through Node running
// short scripts written to temp files, exercising the same code path used by
// `npm install` line streaming.

const assert = require('node:assert');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { nonInteractiveSpawn } = require('#src/components/Application');

// Write `script` to a temp .js file and return its path; auto-removed in `after`.
let workDir;
before(() => {
	workDir = mkdtempSync(join(tmpdir(), 'spawn-onLine-'));
});
after(() => {
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

function writeScript(name, body) {
	const p = join(workDir, name);
	writeFileSync(p, body);
	return p;
}

describe('nonInteractiveSpawn onLine line buffering', () => {
	it('reports each complete line via the onLine callback', async () => {
		const script = writeScript('three-lines.js', `process.stdout.write('first\\nsecond\\nthird\\n');`);
		const lines = [];
		const result = await nonInteractiveSpawn('test-app', 'node', [script], workDir, 30_000, (stream, line) =>
			lines.push({ stream, line })
		);
		assert.strictEqual(result.code, 0, `expected exit 0, got ${result.code}; stderr=${result.stderr}`);
		assert.deepStrictEqual(lines, [
			{ stream: 'stdout', line: 'first' },
			{ stream: 'stdout', line: 'second' },
			{ stream: 'stdout', line: 'third' },
		]);
	});

	it('flushes a trailing partial line (no terminating newline) on process close', async () => {
		const script = writeScript('trailing.js', `process.stdout.write('one\\ntwo without newline');`);
		const lines = [];
		const result = await nonInteractiveSpawn('test-app', 'node', [script], workDir, 30_000, (stream, line) =>
			lines.push({ stream, line })
		);
		assert.strictEqual(result.code, 0);
		assert.deepStrictEqual(lines, [
			{ stream: 'stdout', line: 'one' },
			{ stream: 'stdout', line: 'two without newline' },
		]);
	});

	it('strips a trailing \\r so CRLF-terminated lines arrive clean', async () => {
		const script = writeScript('crlf.js', `process.stdout.write('crlf\\r\\nmore\\r\\n');`);
		const lines = [];
		const result = await nonInteractiveSpawn('test-app', 'node', [script], workDir, 30_000, (_stream, line) =>
			lines.push(line)
		);
		assert.strictEqual(result.code, 0);
		// No trailing \r on either line — splitter normalizes CRLF to LF.
		assert.deepStrictEqual(lines, ['crlf', 'more']);
	});

	it('tags stderr lines with the "stderr" stream label', async () => {
		const script = writeScript(
			'mixed.js',
			`process.stderr.write('warn line\\n'); process.stdout.write('info line\\n');`
		);
		const lines = [];
		const result = await nonInteractiveSpawn('test-app', 'node', [script], workDir, 30_000, (stream, line) =>
			lines.push({ stream, line })
		);
		assert.strictEqual(result.code, 0);
		// stdout/stderr are independent FDs — interleaving order is implementation-defined.
		// Assert content, not order.
		assert.ok(
			lines.some((l) => l.stream === 'stdout' && l.line === 'info line'),
			`expected stdout 'info line', got: ${JSON.stringify(lines)}`
		);
		assert.ok(
			lines.some((l) => l.stream === 'stderr' && l.line === 'warn line'),
			`expected stderr 'warn line', got: ${JSON.stringify(lines)}`
		);
	});

	it('reassembles a multi-byte UTF-8 character split across two chunks', async () => {
		// The ✔ codepoint (U+2714) is 3 bytes in UTF-8 (0xE2 0x9C 0x94). Many package
		// managers print it in their resolved-package summaries. Without a StringDecoder,
		// a chunk boundary that lands inside this sequence corrupts it into U+FFFD
		// replacement characters. Drive a script that writes 200 ✔ characters with a
		// flush in the middle so the OS pipe is very likely to deliver in multiple chunks.
		const script = writeScript(
			'utf8.js',
			`for (let i = 0; i < 200; i++) { process.stdout.write('\\u2714'); }\nprocess.stdout.write('\\n');`
		);
		const lines = [];
		const result = await nonInteractiveSpawn('test-app', 'node', [script], workDir, 30_000, (_stream, line) =>
			lines.push(line)
		);
		assert.strictEqual(result.code, 0);
		assert.strictEqual(lines.length, 1);
		assert.strictEqual(lines[0], '✔'.repeat(200), 'all ✔ characters should be intact, no U+FFFD');
	});

	it('is opt-in: no onLine callback still captures stdout/stderr into the resolve payload', async () => {
		const script = writeScript('opt-in.js', `process.stdout.write('hello world\\n');`);
		const result = await nonInteractiveSpawn('test-app', 'node', [script], workDir, 30_000);
		assert.strictEqual(result.code, 0);
		assert.match(result.stdout, /hello world/);
	});
});
