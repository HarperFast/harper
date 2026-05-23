'use strict';

const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { DeployRenderer } = require('#src/bin/deployRenderer');

function makeOutput() {
	const lines = [];
	const stream = { write: (s) => lines.push(s), isTTY: false };
	return { stream, lines };
}

describe('DeployRenderer', () => {
	describe('upload progress (non-TTY)', () => {
		it('counts pre-gzip bytes via countUploadBytes and prints a single completion line', async () => {
			const { stream, lines } = makeOutput();
			// 4 × 262_144 = 1_048_576 bytes = exactly 1 MiB (clean binary unit).
			const CHUNK = 262_144;
			const renderer = new DeployRenderer({ uploadTotal: 4 * CHUNK, output: stream });
			const source = new PassThrough();
			const tap = renderer.tapUploadStream(source);
			// Drain into a sink so backpressure doesn't pause the tap.
			const sink = new PassThrough();
			tap.pipe(sink);
			sink.on('data', () => {});
			// Simulate pre-gzip counting via countUploadBytes — in production this is driven
			// by the tar pack stream's onBytes callback; the tap Transform no longer counts bytes.
			for (let i = 0; i < 4; i++) {
				const chunk = Buffer.alloc(CHUNK);
				source.write(chunk);
				renderer.countUploadBytes(chunk.length);
			}
			source.end();
			await new Promise((resolve) => sink.on('end', resolve));
			// No intermediate progress lines — only the final completion line.
			assert.strictEqual(lines.length, 1, `expected 1 line, got ${lines.length}: ${lines.join('|')}`);
			assert.match(lines[0], /^Uploaded 1\.0 MiB/, `expected Uploaded 1.0 MiB, got: ${lines[0]}`);
		});

		it('endUpload is idempotent', () => {
			const { stream, lines } = makeOutput();
			const renderer = new DeployRenderer({ uploadTotal: 100, output: stream });
			renderer.tapUploadStream(new PassThrough());
			renderer.endUpload();
			renderer.endUpload();
			const completeLines = lines.filter((l) => l.startsWith('Uploaded '));
			assert.strictEqual(completeLines.length, 1);
		});
	});

	describe('renderEvent', () => {
		function sseMessage(event, data) {
			return { event, data: JSON.stringify(data) };
		}

		it('prints a phase line on start, then on done (no duplicate start)', () => {
			const { stream, lines } = makeOutput();
			const renderer = new DeployRenderer({ output: stream });
			renderer.renderEvent(sseMessage('phase', { phase: 'extract', status: 'start' }));
			renderer.renderEvent(sseMessage('phase', { phase: 'extract', status: 'start' }));
			renderer.renderEvent(sseMessage('phase', { phase: 'extract', status: 'done' }));
			assert.deepStrictEqual(lines, ['extract…\n', 'extract done\n']);
		});

		it('forwards install stdout/stderr lines and headers the manager name once', () => {
			const { stream, lines } = makeOutput();
			const renderer = new DeployRenderer({ output: stream });
			renderer.renderEvent(sseMessage('phase', { phase: 'install', status: 'start' }));
			renderer.renderEvent(sseMessage('install', { manager: 'npm', stream: 'stdout', line: 'added 42 packages' }));
			renderer.renderEvent(sseMessage('install', { manager: 'npm', stream: 'stdout', line: 'audited 100 packages' }));
			renderer.renderEvent(
				sseMessage('install', { manager: 'npm', stream: 'stderr', line: 'npm warn deprecated foo' })
			);
			renderer.renderEvent(sseMessage('phase', { phase: 'install', status: 'done' }));
			assert.ok(lines.includes('install: using npm\n'), 'expected manager header');
			assert.strictEqual(
				lines.filter((l) => l === 'install: using npm\n').length,
				1,
				'manager header logged only once'
			);
			assert.ok(lines.includes('  | added 42 packages\n'));
			assert.ok(lines.includes('  | audited 100 packages\n'));
			assert.ok(lines.includes('  ! npm warn deprecated foo\n'), 'stderr should be tagged with !');
			assert.ok(
				lines.some((l) => /install done \(3 log lines\)/.test(l)),
				'install-done should count emitted lines'
			);
		});

		it('renders an error event with code suffix', () => {
			const { stream, lines } = makeOutput();
			const renderer = new DeployRenderer({ output: stream });
			renderer.renderEvent(sseMessage('error', { message: 'npm install failed', code: 500 }));
			assert.match(lines[0], /error: npm install failed \(500\)/);
		});

		it('renders a phase-error with the message', () => {
			const { stream, lines } = makeOutput();
			const renderer = new DeployRenderer({ output: stream });
			renderer.renderEvent(sseMessage('phase', { phase: 'install', status: 'error', message: 'exit code 1' }));
			assert.match(lines[0], /install ERROR: exit code 1/);
		});
	});
});
