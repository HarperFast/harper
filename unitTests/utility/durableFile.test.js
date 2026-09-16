'use strict';

const assert = require('node:assert');
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { fsyncDirectory, removeFileDurably, writeFileDurably } = require('#src/utility/durableFile');

describe('durableFile', function () {
	let tempDir;

	beforeEach(function () {
		tempDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.durable-file-'));
	});

	afterEach(function () {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe('writeFileDurably', function () {
		it('writes the file and leaves no temp behind', function () {
			const target = join(tempDir, 'state.json');
			writeFileDurably(target, '{"a":1}', 'state.tmp');

			assert.strictEqual(readFileSync(target, 'utf8'), '{"a":1}');
			assert.deepStrictEqual(readdirSync(tempDir), ['state.json']);
		});

		it('replaces existing content in one step', function () {
			const target = join(tempDir, 'state.json');
			writeFileDurably(target, 'first', 'state.tmp');
			writeFileDurably(target, 'second', 'state.tmp');

			assert.strictEqual(readFileSync(target, 'utf8'), 'second');
			assert.deepStrictEqual(readdirSync(tempDir), ['state.json']);
		});

		it('overwrites a temp file a crashed write left behind', function () {
			const target = join(tempDir, 'state.json');
			writeFileSync(join(tempDir, 'state.tmp'), 'debris from an interrupted write');

			writeFileDurably(target, 'clean', 'state.tmp');

			assert.strictEqual(readFileSync(target, 'utf8'), 'clean');
			assert.deepStrictEqual(readdirSync(tempDir), ['state.json']);
		});

		it('leaves the previous content in place when the write cannot be published', function () {
			const target = join(tempDir, 'state.json');
			writeFileDurably(target, 'original', 'state.tmp');
			// a directory at the temp path makes the write fail before the rename can replace the target
			mkdirSync(join(tempDir, 'blocked.tmp'));

			assert.throws(() => writeFileDurably(target, 'replacement', 'blocked.tmp'));
			assert.strictEqual(readFileSync(target, 'utf8'), 'original');
		});
	});

	describe('removeFileDurably', function () {
		it('removes the file', function () {
			const target = join(tempDir, 'state.json');
			writeFileDurably(target, 'gone soon', 'state.tmp');

			removeFileDurably(target);

			assert.ok(!existsSync(target));
		});

		it('treats a missing file as already removed', function () {
			removeFileDurably(join(tempDir, 'never-existed'));
		});
	});

	describe('fsyncDirectory', function () {
		it('flushes a real directory without throwing', function () {
			fsyncDirectory(tempDir);
		});

		it('propagates a failure that is not a platform limitation', function () {
			assert.throws(() => fsyncDirectory(join(tempDir, 'no-such-directory')), { code: 'ENOENT' });
		});

		it('tolerates a platform that rejects the flush rather than the open', function () {
			// Windows opens a directory happily and fails the fsync with EPERM; a durable write must not
			// throw there, so both limbs are tolerated
			const target = join(tempDir, 'state.json');
			writeFileDurably(target, 'written', 'state.tmp');
			removeFileDurably(target);
			assert.ok(!existsSync(target));
		});
	});
});
