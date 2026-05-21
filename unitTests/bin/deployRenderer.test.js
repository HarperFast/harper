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
		it('advances bytes as data flows through the tap and logs at 10% steps', async () => {
			const { stream, lines } = makeOutput();
			const renderer = new DeployRenderer({ uploadTotal: 1_000_000, output: stream });
			const source = new PassThrough();
			const tap = renderer.tapUploadStream(source);
			// Drain into a sink so backpressure doesn't pause the tap.
			const sink = new PassThrough();
			tap.pipe(sink);
			sink.on('data', () => {});
			// Write 5×200_000 byte chunks → 1MB total, crossing each 10% threshold.
			for (let i = 0; i < 5; i++) source.write(Buffer.alloc(200_000));
			source.end();
			await new Promise((resolve) => sink.on('end', resolve));
			renderer.endUpload();
			// Expect at least one per-10% progress line plus the final "Upload complete" line.
			const progressLines = lines.filter((l) => /Uploaded /.test(l));
			assert.ok(
				progressLines.length >= 4,
				`expected multiple progress lines, got ${progressLines.length}: ${progressLines.join('|')}`
			);
			assert.ok(
				lines.some((l) => l.startsWith('Upload complete')),
				'should log Upload complete on endUpload'
			);
		});

		it('endUpload is idempotent', () => {
			const { stream, lines } = makeOutput();
			const renderer = new DeployRenderer({ uploadTotal: 100, output: stream });
			renderer.tapUploadStream(new PassThrough());
			renderer.endUpload();
			renderer.endUpload();
			const completeLines = lines.filter((l) => l.startsWith('Upload complete'));
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
