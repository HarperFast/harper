const { EntryHandler } = require('#src/components/EntryHandler');
const { EventEmitter, once } = require('node:events');
const assert = require('node:assert');
const { join, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { writeFile, mkdir } = require('node:fs/promises');
const { spy } = require('sinon');
const { waitFor } = require('../waitFor.js');

function generateFixture(dirPath, fixture) {
	mkdirSync(dirPath, { recursive: true });
	for (const entry of fixture) {
		if (typeof entry === 'string') {
			writeFileSync(join(dirPath, entry), entry);
		} else {
			generateFixture(join(dirPath, entry[0]), entry[1]);
		}
	}
}

function createFixture(fixture) {
	const dirPath = mkdtempSync(join(tmpdir(), 'harper.unit-test.entry-handler-'));

	generateFixture(dirPath, fixture);

	return { directory: dirPath };
}

describe('EntryHandler', () => {
	const fixture = ['a', 'b', 'c', ['foo', ['d', 'e', ['bar', ['f', 'g']]]]];
	beforeEach(() => {
		const { directory } = createFixture(fixture);
		this.name = basename(directory);
		this.directory = directory;
	});

	afterEach(() => {
		try {
			rmSync(this.directory, { recursive: true, force: true });
			// eslint-disable-next-line sonarjs/no-ignored-exceptions
		} catch {
			// best effort to clean up - but doesn't matter too much since this is a temp directory
		}
	});

	it('should instantiate and emit events for adding and removing files and directories', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, '.');

		assert.equal(entryHandler.name, this.name, 'name should be the same');
		assert.equal(entryHandler.directory, this.directory, 'directory should be the same');
		assert.ok(entryHandler instanceof EventEmitter, 'EntryHandler should be an instance of EventEmitter');

		const readyEventSpy = spy();
		entryHandler.on('ready', readyEventSpy);

		const closeEventSpy = spy();
		entryHandler.on('close', closeEventSpy);

		const allHandlerSpy = spy();
		entryHandler.on('all', allHandlerSpy);

		const addHandlerSpy = spy();
		entryHandler.on('add', addHandlerSpy);

		const unlinkHandlerSpy = spy();
		entryHandler.on('unlink', unlinkHandlerSpy);

		const addDirHandlerSpy = spy();
		entryHandler.on('addDir', addDirHandlerSpy);

		const unlinkDirHandlerSpy = spy();
		entryHandler.on('unlinkDir', unlinkDirHandlerSpy);

		await once(entryHandler, 'ready');
		assert.equal(readyEventSpy.callCount, 1, 'ready event should be triggered once');

		// Initial add events
		await waitFor(() => allHandlerSpy.callCount === 10);
		assert.equal(allHandlerSpy.callCount, 10, 'all event should be triggered for each entry');
		assert.equal(addHandlerSpy.callCount, 7, 'add event should be triggered for each file');
		assert.equal(addDirHandlerSpy.callCount, 3, 'addDir event should be triggered for each directory');

		// New file creation
		const addFileEvent = once(entryHandler, 'add');
		const newFilePath = join(this.directory, 'x');
		await writeFile(newFilePath, 'x');
		await addFileEvent;
		assert.equal(addHandlerSpy.callCount, 8, 'add event should be triggered for the new file');
		const addFileArg = addHandlerSpy.getCall(7).args[0];
		assert.equal(addFileArg.absolutePath, newFilePath, 'add event argument `absolutePath` should be the file path');
		assert.deepEqual(addFileArg.contents, Buffer.from('x'), 'add event argument contents should be the file contents');
		assert.equal(addFileArg.entryType, 'file', 'add event argument `entryType` should be `file`');
		assert.equal(addFileArg.eventType, 'add', 'add event argument `eventType` should be `add`');
		assert.equal(addFileArg.urlPath, '/x', 'add event argument `urlPath` should be file name');
		assert.ok(addFileArg.stats !== undefined, 'add event argument `stats` should be defined');
		assert.ok(addFileArg.stats.isFile(), 'add event argument `stats` should be a file');

		// New directory creation
		const addDirEvent = once(entryHandler, 'addDir');
		const newDirPath = join(this.directory, 'fuzz');
		await mkdir(newDirPath);
		await addDirEvent;
		assert.equal(addDirHandlerSpy.callCount, 4, 'addDir event should be triggered for the new directory');
		const addDirArg = addDirHandlerSpy.getCall(3).args[0];
		assert.equal(
			addDirArg.absolutePath,
			newDirPath,
			'addDir event argument `absolutePath` should be the directory path'
		);
		assert.equal(addDirArg.entryType, 'directory', 'addDir event argument `entryType` should be `directory`');
		assert.equal(addDirArg.eventType, 'addDir', 'addDir event argument `eventType` should be `addDir`');
		assert.equal(addDirArg.urlPath, '/fuzz', 'addDir event argument `urlPath` should be the directory name');
		assert.ok(addDirArg.stats !== undefined, 'addDir event argument `stats` should be defined');
		assert.ok(addDirArg.stats.isDirectory(), 'addDir event argument `stats` should be a directory');

		// New file creation in new directory
		const addFileInDirEvent = once(entryHandler, 'add');
		const newFileInDirPath = join(newDirPath, 'y');
		await writeFile(newFileInDirPath, 'y');
		await addFileInDirEvent;
		assert.equal(addHandlerSpy.callCount, 9, 'add event should be triggered for the new file in new directory');
		const addFileInDirArg = addHandlerSpy.getCall(8).args[0];
		assert.equal(
			addFileInDirArg.absolutePath,
			newFileInDirPath,
			'add event argument `absolutePath` should be the file path'
		);
		assert.deepEqual(
			addFileInDirArg.contents,
			Buffer.from('y'),
			'add event argument contents should be the file contents'
		);
		assert.equal(addFileInDirArg.entryType, 'file', 'add event argument `entryType` should be `file`');
		assert.equal(addFileInDirArg.eventType, 'add', 'add event argument `eventType` should be `add`');
		assert.equal(addFileInDirArg.urlPath, '/fuzz/y', 'add event argument `urlPath` should be file name');
		assert.ok(addFileInDirArg.stats !== undefined, 'add event argument `stats` should be defined');
		assert.ok(addFileInDirArg.stats.isFile(), 'add event argument `stats` should be a file');

		// New directory creation in new directory
		const addDirInDirEvent = once(entryHandler, 'addDir');
		const newDirInDirPath = join(newDirPath, 'buzz');
		await mkdir(newDirInDirPath);
		await addDirInDirEvent;
		assert.equal(
			addDirHandlerSpy.callCount,
			5,
			'addDir event should be triggered for the new directory in new directory'
		);
		const addDirInDirArg = addDirHandlerSpy.getCall(4).args[0];
		assert.equal(
			addDirInDirArg.absolutePath,
			newDirInDirPath,
			'addDir event argument `absolutePath` should be the directory path'
		);
		assert.equal(addDirInDirArg.entryType, 'directory', 'addDir event argument `entryType` should be `directory`');
		assert.equal(addDirInDirArg.eventType, 'addDir', 'addDir event argument `eventType` should be `addDir`');
		assert.equal(addDirInDirArg.urlPath, '/fuzz/buzz', 'addDir event argument `urlPath` should be the directory name');
		assert.ok(addDirInDirArg.stats !== undefined, 'addDir event argument `stats` should be defined');
		assert.ok(addDirInDirArg.stats.isDirectory(), 'addDir event argument `stats` should be a directory');

		// File removal
		const unlinkFileEvent = once(entryHandler, 'unlink');
		rmSync(newFilePath);
		await unlinkFileEvent;
		assert.equal(unlinkHandlerSpy.callCount, 1, 'unlink event should be triggered for the removed file');
		const unlinkFileArg = unlinkHandlerSpy.getCall(0).args[0];
		assert.equal(
			unlinkFileArg.absolutePath,
			newFilePath,
			'unlink event argument `absolutePath` should be the file path'
		);
		assert.equal(unlinkFileArg.entryType, 'file', 'unlink event argument `entryType` should be `file`');
		assert.equal(unlinkFileArg.eventType, 'unlink', 'unlink event argument `eventType` should be `unlink`');
		assert.equal(unlinkFileArg.urlPath, '/x', 'unlink event argument `urlPath` should be file name');
		assert.equal(unlinkFileArg.content, undefined, 'unlink event argument `content` should not be defined');
		assert.equal(unlinkFileArg.stats, undefined, 'unlink event argument `stats` should not be defined');

		// Directory removal
		const unlinkDirEvent = once(entryHandler, 'unlinkDir');
		rmSync(newDirInDirPath, { recursive: true });
		await unlinkDirEvent;
		assert.equal(unlinkDirHandlerSpy.callCount, 1, 'unlinkDir event should be triggered for the removed directory');
		const unlinkDirArg = unlinkDirHandlerSpy.getCall(0).args[0];
		assert.equal(
			unlinkDirArg.absolutePath,
			newDirInDirPath,
			'unlinkDir event argument `absolutePath` should be the directory path'
		);
		assert.equal(unlinkDirArg.entryType, 'directory', 'unlinkDir event argument `entryType` should be `directory`');
		assert.equal(unlinkDirArg.eventType, 'unlinkDir', 'unlinkDir event argument `eventType` should be `unlinkDir`');
		assert.equal(unlinkDirArg.urlPath, '/fuzz/buzz', 'unlinkDir event argument `urlPath` should be the directory name');
		assert.equal(unlinkDirArg.content, undefined, 'unlinkDir event argument `content` should not be defined');
		assert.equal(unlinkDirArg.stats, undefined, 'unlinkDir event argument `stats` should not be defined');

		await entryHandler.close();
		assert.equal(closeEventSpy.callCount, 1, 'close event should be triggered once');

		assert.equal(entryHandler.listenerCount('ready'), 0, 'ready event listener should be removed');
		assert.equal(entryHandler.listenerCount('close'), 0, 'close event listener should be removed');
		assert.equal(entryHandler.listenerCount('all'), 0, 'all event listener should be removed');
		assert.equal(entryHandler.listenerCount('add'), 0, 'add event listener should be removed');
		assert.equal(entryHandler.listenerCount('unlink'), 0, 'unlink event listener should be removed');
		assert.equal(entryHandler.listenerCount('addDir'), 0, 'addDir event listener should be removed');
		assert.equal(entryHandler.listenerCount('unlinkDir'), 0, 'unlinkDir event listener should be removed');
	});

	it('should await ready event via `ready` property', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, './');

		const readyEventSpy = spy();
		entryHandler.on('ready', readyEventSpy);
		await entryHandler.ready;
		assert.equal(readyEventSpy.callCount, 1, 'ready event should be triggered once');

		await entryHandler.close();
	});

	it('should emit file change events', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, './a');
		await entryHandler.ready;

		const changeHandlerSpy = spy();
		entryHandler.on('change', changeHandlerSpy);

		const changeEvent = once(entryHandler, 'change');
		const changeFilePath = join(this.directory, 'a');
		await writeFile(changeFilePath, 'new content');
		await changeEvent;

		assert.equal(changeHandlerSpy.callCount, 1, 'change event should be triggered twice');
		const changeArg = changeHandlerSpy.getCall(0).args[0];
		assert.equal(
			changeArg.absolutePath,
			changeFilePath,
			'change event argument `absolutePath` should be the file path'
		);
		assert.equal(changeArg.entryType, 'file', 'change event argument `entryType` should be `file`');
		assert.equal(changeArg.eventType, 'change', 'change event argument `eventType` should be `change`');
		assert.equal(changeArg.urlPath, '/a', 'change event argument `urlPath` should be file name');
		assert.deepEqual(
			changeArg.contents,
			Buffer.from('new content'),
			'change event argument `content` should be undefined to start'
		);
		assert.ok(changeArg.stats !== undefined, 'change event argument `stats` should be defined');
		assert.ok(changeArg.stats.isFile(), 'change event argument `stats` should be a file');

		await entryHandler.close();
	});

	it('emits logical file and directory diffs after pause and resume', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, '.');
		await entryHandler.ready;

		const entries = [];
		let readyCount = 0;
		entryHandler.on('all', (entry) => entries.push(entry));
		entryHandler.on('ready', () => readyCount++);

		entryHandler.pause();
		await writeFile(join(this.directory, 'b'), 'changed');
		rmSync(join(this.directory, 'c'));
		await writeFile(join(this.directory, 'new-file'), 'new');
		await mkdir(join(this.directory, 'new-directory'));
		rmSync(join(this.directory, 'foo', 'bar'), { recursive: true });

		await entryHandler.resume();

		assert.equal(readyCount, 1, 'the resumed watcher emits ready once');
		assert.equal(
			entries.some((entry) => entry.absolutePath === join(this.directory, 'a')),
			false,
			'an unchanged file emits no redeploy event'
		);
		assert.deepEqual(
			entries
				.map((entry) => [entry.eventType, entry.absolutePath.slice(this.directory.length + 1)])
				.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])),
			[
				['change', 'b'],
				['unlink', 'c'],
				['unlinkDir', 'foo/bar'],
				['unlink', 'foo/bar/f'],
				['unlink', 'foo/bar/g'],
				['addDir', 'new-directory'],
				['add', 'new-file'],
			].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
		);
		assert.deepEqual(
			entries.find((entry) => entry.absolutePath === join(this.directory, 'b')).contents,
			Buffer.from('changed'),
			'the synthesized change carries the post-deploy contents'
		);
		const removedSubtreeEvents = entries
			.filter((entry) => entry.absolutePath.startsWith(join(this.directory, 'foo', 'bar')))
			.map((entry) => entry.eventType);
		assert.deepEqual(
			removedSubtreeEvents,
			['unlink', 'unlink', 'unlinkDir'],
			'children are unlinked before their directory'
		);

		await entryHandler.close();
	});

	it('emits unlink then add when an entry changes type across pause and resume', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, '.');
		await entryHandler.ready;

		const entries = [];
		entryHandler.on('all', (entry) => {
			if (entry.absolutePath === join(this.directory, 'a')) entries.push(entry);
		});

		entryHandler.pause();
		rmSync(join(this.directory, 'a'));
		await mkdir(join(this.directory, 'a'));
		await entryHandler.resume();

		assert.deepEqual(
			entries.map((entry) => entry.eventType),
			['unlink', 'addDir']
		);
		await entryHandler.close();
	});

	it('commits the resumed generation even when a removal listener throws synchronously', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, '.');
		await entryHandler.ready;

		let emittedError;
		let unlinkCount = 0;
		entryHandler.on('error', (error) => (emittedError = error));
		entryHandler.on('unlink', (entry) => {
			if (entry.absolutePath === join(this.directory, 'c')) {
				unlinkCount++;
				throw new Error('removal listener failed');
			}
		});

		entryHandler.pause();
		rmSync(join(this.directory, 'c'));
		await entryHandler.resume();
		assert.equal(emittedError?.message, 'removal listener failed');
		assert.equal(unlinkCount, 1);

		entryHandler.pause();
		await entryHandler.resume();
		assert.equal(unlinkCount, 1, 'the committed snapshot does not replay the same removal');
		await entryHandler.close();
	});

	it('routes steady-state unlink and addDir listener throws through error', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, '.');
		await entryHandler.ready;

		const errors = [];
		entryHandler.on('error', (error) => errors.push(error));
		entryHandler.on('unlink', (entry) => {
			if (entry.absolutePath === join(this.directory, 'c')) throw new Error('unlink listener failed');
		});
		entryHandler.on('addDir', (entry) => {
			if (entry.absolutePath === join(this.directory, 'new-directory')) throw new Error('addDir listener failed');
		});

		rmSync(join(this.directory, 'c'));
		await waitFor(() => errors.length === 1);
		await mkdir(join(this.directory, 'new-directory'));
		await waitFor(() => errors.length === 2);
		assert.deepEqual(
			errors.map((error) => error.message),
			['unlink listener failed', 'addDir listener failed']
		);
		await entryHandler.close();
	});

	it('ignores a pending read from the watcher generation invalidated by pause', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, '.');
		await entryHandler.ready;

		const entries = [];
		entryHandler.on('all', (entry) => entries.push(entry));
		let resolveRead;
		const pendingRead = entryHandler._simulateFileReadForTests(
			'add',
			'stale-file',
			new Promise((resolve) => (resolveRead = resolve))
		);

		entryHandler.pause();
		resolveRead(Buffer.from('pre-deploy'));
		await pendingRead;
		await entryHandler.resume();

		assert.equal(entries.length, 0, 'stale reads neither emit nor pollute the resumed generation diff');
		await entryHandler.close();
	});

	it('carries entries emitted by an interrupted first scan into the resumed diff', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, '.');
		const resourcePath = join(this.directory, 'resource.js');
		const resourceEvents = [];
		entryHandler.on('all', (entry) => {
			if (entry.absolutePath === resourcePath) resourceEvents.push(entry);
		});

		let resolveHold;
		const holdRead = entryHandler._simulateFileReadForTests(
			'add',
			'hold-open',
			new Promise((resolve) => (resolveHold = resolve))
		);
		await entryHandler._simulateFileReadForTests('add', 'resource.js', Promise.resolve(Buffer.from('old')));
		assert.deepEqual(
			resourceEvents.map((entry) => entry.eventType),
			['add']
		);

		entryHandler.pause();
		await writeFile(resourcePath, 'new');
		resolveHold(Buffer.from('ignored'));
		await holdRead;
		await entryHandler.resume();

		assert.deepEqual(
			resourceEvents.map((entry) => entry.eventType),
			['add', 'change'],
			'an entry already exposed to consumers is changed, not replayed as a fresh add'
		);
		await entryHandler.close();
	});

	it('preserves the pre-deploy snapshot when update races the resumed scan', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, '.');
		await entryHandler.ready;

		const entries = [];
		entryHandler.on('all', (entry) => entries.push(entry));
		entryHandler.pause();
		rmSync(join(this.directory, 'c'));

		await Promise.all([entryHandler.resume(), entryHandler.update('.')]);
		assert.deepEqual(
			entries.filter((entry) => entry.absolutePath === join(this.directory, 'c')).map((entry) => entry.eventType),
			['unlink'],
			'the superseding update generation retains the deletion diff exactly once'
		);
		await entryHandler.close();
	});

	it('invalidates a pending outgoing read before applying new URL configuration', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, { files: 'a', urlPath: '/old' });
		await entryHandler.ready;

		const entries = [];
		entryHandler.on('all', (entry) => entries.push(entry));
		let resolveRead;
		const pendingRead = entryHandler._simulateFileReadForTests(
			'change',
			'a',
			new Promise((resolve) => (resolveRead = resolve))
		);
		const update = entryHandler.update({ files: 'a', urlPath: '/new' });
		resolveRead(Buffer.from('stale'));

		await Promise.all([pendingRead, update]);
		assert.deepEqual(
			entries.map((entry) => [entry.eventType, entry.urlPath]),
			[
				['unlink', '/old/a'],
				['add', '/new/a'],
			]
		);
		await entryHandler.close();
	});

	it('preserves a known file when a redeploy scan cannot read it', async () => {
		if (process.platform === 'win32') return;
		const entryHandler = new EntryHandler(this.name, this.directory, 'a');
		await entryHandler.ready;
		const pollingReady = once(entryHandler, 'ready');
		entryHandler._simulateWatcherErrorForTests(Object.assign(new Error('exhausted'), { code: 'ENOSPC' }));
		await pollingReady;

		const entries = [];
		const errors = [];
		entryHandler.on('all', (entry) => entries.push(entry));
		entryHandler.on('error', (error) => errors.push(error));
		const filePath = join(this.directory, 'a');
		entryHandler.pause();
		chmodSync(filePath, 0o000);
		try {
			await entryHandler.resume();
			await waitFor(() => errors.length === 1);
			assert.equal(errors[0].code, 'EACCES');
			assert.equal(
				entries.some((entry) => entry.eventType === 'unlink'),
				false
			);
		} finally {
			chmodSync(filePath, 0o600);
			await entryHandler.close();
		}
	});

	it('routes primitive listener throws through error without rejecting the file read', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, '.');
		await entryHandler.ready;

		let emittedError;
		const listenerFailure = 'listener failed';
		entryHandler.on('error', (error) => (emittedError = error));
		entryHandler.on('change', () => {
			throw listenerFailure;
		});

		await writeFile(join(this.directory, 'a'), 'changed');
		await waitFor(() => emittedError !== undefined);
		assert.equal(emittedError, listenerFailure);
		await entryHandler.close();
	});

	it('should handle updating the config', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, 'a');

		const readyEventSpy = spy();
		entryHandler.on('ready', readyEventSpy);

		const closeEventSpy = spy();
		entryHandler.on('close', closeEventSpy);

		const allHandlerSpy = spy();
		entryHandler.on('all', allHandlerSpy);

		const addHandlerSpy = spy();
		entryHandler.on('add', addHandlerSpy);

		const addDirHandlerSpy = spy();
		entryHandler.on('addDir', addDirHandlerSpy);
		const unlinkHandlerSpy = spy();
		entryHandler.on('unlink', unlinkHandlerSpy);

		await waitFor(() => allHandlerSpy.callCount === 1);

		assert.equal(readyEventSpy.callCount, 1, 'ready event should be triggered once');
		assert.equal(allHandlerSpy.callCount, 1, 'all event should be triggered for each entry');
		assert.equal(addHandlerSpy.callCount, 1, 'add event should be triggered for the singular file');
		const addArgA = addHandlerSpy.getCall(0).args[0];
		const aPath = join(this.directory, 'a');
		assert.equal(addArgA.absolutePath, aPath, 'add event should be triggered with the correct arguments');
		assert.deepEqual(addArgA.contents, Buffer.from('a'), 'add event should be triggered with the correct arguments');
		assert.equal(addArgA.entryType, 'file', 'add event should be triggered with the correct arguments');
		assert.equal(addArgA.eventType, 'add', 'add event should be triggered with the correct arguments');
		// Skip asserting stats as values such as atimeMx will differ
		assert.equal(addArgA.urlPath, '/a', 'add event should be triggered with the correct arguments');
		assert.equal(addDirHandlerSpy.callCount, 0, 'addDir event should not be triggered');

		readyEventSpy.resetHistory();
		allHandlerSpy.resetHistory();
		addHandlerSpy.resetHistory();
		addDirHandlerSpy.resetHistory();
		unlinkHandlerSpy.resetHistory();

		await entryHandler.update('b');

		await waitFor(() => allHandlerSpy.callCount === 2);

		assert.equal(readyEventSpy.callCount, 1, 'ready event should be triggered again once');
		assert.equal(allHandlerSpy.callCount, 2, 'the old match is removed before the new match is added');
		assert.equal(unlinkHandlerSpy.callCount, 1, 'the old config match emits unlink');
		assert.equal(unlinkHandlerSpy.getCall(0).args[0].absolutePath, aPath);
		assert.equal(addHandlerSpy.callCount, 1, 'add event should be triggered for the updated singular file');
		const addArgB = addHandlerSpy.getCall(0).args[0];
		const bPath = join(this.directory, 'b');
		assert.equal(addArgB.absolutePath, bPath, 'add event should be triggered with the correct arguments');
		assert.deepEqual(addArgB.contents, Buffer.from('b'), 'add event should be triggered with the correct arguments');
		assert.equal(addArgB.entryType, 'file', 'add event should be triggered with the correct arguments');
		assert.equal(addArgB.eventType, 'add', 'add event should be triggered with the correct arguments');
		// Skip asserting stats as values such as atimeMx will differ
		assert.equal(addArgB.urlPath, '/b', 'add event should be triggered with the correct arguments');
		assert.equal(addDirHandlerSpy.callCount, 0, 'addDir event should not be triggered');

		await entryHandler.close();
		assert.equal(closeEventSpy.callCount, 1, 'close event should be triggered once');
		assert.equal(entryHandler.listenerCount('ready'), 0, 'ready event listener should be removed');
		assert.equal(entryHandler.listenerCount('close'), 0, 'close event listener should be removed');
		assert.equal(entryHandler.listenerCount('all'), 0, 'all event listener should be removed');
		assert.equal(entryHandler.listenerCount('add'), 0, 'add event listener should be removed');
		assert.equal(entryHandler.listenerCount('addDir'), 0, 'addDir event listener should be removed');
	});

	it('serializes concurrent config updates without orphaning a watcher', async () => {
		// A single config save that changes both `files` and `urlPath` drives two OptionsWatcher
		// `change` events in one tick, so two update() calls enter watcher replacement while a
		// watcher is live (not paused). Each must close the watcher it actually replaced —
		// otherwise the first call's fresh chokidar instance is overwritten, never closed, and
		// its inotify handles leak until GC (the pressure mode of harper#488).
		const entryHandler = new EntryHandler(this.name, this.directory, 'a');
		await entryHandler.ready;
		assert.equal(entryHandler._liveWatcherCountForTests, 1, 'one live watcher after the initial scan');

		await Promise.all([entryHandler.update('b'), entryHandler.update('c')]);

		assert.equal(entryHandler._openCountForTests, 3, 'the initial watcher plus one per update');
		assert.equal(entryHandler._liveWatcherCountForTests, 1, 'each replacement closes the watcher it replaced');

		await entryHandler.close();
		assert.equal(entryHandler._liveWatcherCountForTests, 0, 'close() releases the last watcher');
	});

	it('update() readiness does not resolve against the outgoing generation', async () => {
		// update() must re-arm the readiness latch the way pause() does. Otherwise awaiting it on
		// an already-ready handler resolves immediately against the previous generation's `ready`,
		// before the replacement generation has scanned, digested, and emitted its diff.
		const entryHandler = new EntryHandler(this.name, this.directory, 'a');
		await entryHandler.ready;

		const events = [];
		entryHandler.on('all', (entry) => events.push(entry.eventType));

		await entryHandler.update('b');

		assert.deepEqual(
			[...events].sort(),
			['add', 'unlink'],
			'the new generation has emitted its full diff by the time update() resolves'
		);

		await entryHandler.close();
	});

	it('should resolve the correct urlPath for files', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, 'foo/d');

		const addHandlerSpy = spy();
		entryHandler.on('add', addHandlerSpy);

		await entryHandler.ready;

		assert.equal(addHandlerSpy.callCount, 1, 'add event should have been triggered once');
		assert.equal(addHandlerSpy.getCall(0).args[0].urlPath, '/d', 'urlPath resolution should account for similarities');
	});

	it('should resolve the correct urlPath for files with `./`', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, './foo/d');

		const addHandlerSpy = spy();
		entryHandler.on('add', addHandlerSpy);

		await entryHandler.ready;

		assert.equal(addHandlerSpy.callCount, 1, 'add event should have been triggered once');
		assert.equal(addHandlerSpy.getCall(0).args[0].urlPath, '/d', 'urlPath resolution should account for similarities');
	});

	it('should avoid matching within an excluded base', async () => {
		const { directory } = createFixture([
			['bad', [['web', ['a', 'b', 'c']]]],
			['web', ['a', 'b', 'c']],
			['static', ['a', 'b', 'c']],
		]);

		// Given this pattern we want to ensure that the matcher isn't going to return the
		// `bad/web` directory, but will return the `web` and `static` directories even though
		// the `web/*` could match the `bad/web` directory contents.
		const entryHandler = new EntryHandler(basename(directory), directory, ['web/*', 'static/*']);

		const allHandlerSpy = spy();
		entryHandler.on('all', allHandlerSpy);

		const addHandlerSpy = spy();
		entryHandler.on('add', addHandlerSpy);

		const addDirHandlerSpy = spy();
		entryHandler.on('addDir', addDirHandlerSpy);

		await entryHandler.ready;

		assert.equal(allHandlerSpy.callCount, 6, 'all event should be triggered for each matching entry');
		assert.equal(addHandlerSpy.callCount, 6, 'add event should be triggered for each matching file');
		assert.equal(addDirHandlerSpy.callCount, 0, 'addDir event should be triggered for each matching directory');

		await entryHandler.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it('should correctly resolve similar url paths for directories', async () => {
		const { directory } = createFixture([
			[
				'web',
				[
					['static', ['a', 'b']],
					['static-assets', ['c', 'd']],
				],
			],
		]);

		const entryHandler = new EntryHandler(basename(directory), directory, ['web/static/*', 'web/static-*']);

		const allHandlerSpy = spy();
		entryHandler.on('all', allHandlerSpy);

		const addHandlerSpy = spy();
		entryHandler.on('add', addHandlerSpy);

		const addDirHandlerSpy = spy();
		entryHandler.on('addDir', addDirHandlerSpy);

		await entryHandler.ready;

		await waitFor(() => allHandlerSpy.callCount === 3);
		assert.equal(allHandlerSpy.callCount, 3, 'all event should be triggered for each matching entry');
		assert.equal(addHandlerSpy.callCount, 2, 'add event should be triggered for each matching file');
		assert.equal(addDirHandlerSpy.callCount, 1, 'addDir event should be triggered for each matching directory');

		assert.deepEqual(
			addHandlerSpy
				.getCalls()
				.map((call) => call.args[0].urlPath)
				.sort(),
			['/a', '/b']
		);
		assert.equal(
			addDirHandlerSpy.getCall(0).args[0].urlPath,
			'/static-assets',
			'urlPath resolution should account for similarities'
		);

		await entryHandler.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it('should correctly resolve similar url paths for files', async () => {
		const { directory } = createFixture([
			[
				'web',
				[
					['static', ['a', 'b']],
					['static-assets', ['c', 'd']],
				],
			],
		]);

		const entryHandler = new EntryHandler(basename(directory), directory, ['web/static/*', 'web/static-*/*']);

		const allHandlerSpy = spy();
		entryHandler.on('all', allHandlerSpy);

		const addHandlerSpy = spy();
		entryHandler.on('add', addHandlerSpy);

		const addDirHandlerSpy = spy();
		entryHandler.on('addDir', addDirHandlerSpy);

		await entryHandler.ready;

		await waitFor(() => allHandlerSpy.callCount === 4);
		assert.equal(allHandlerSpy.callCount, 4, 'all event should be triggered for each matching entry');
		assert.equal(addHandlerSpy.callCount, 4, 'add event should be triggered for each matching file');
		assert.equal(addDirHandlerSpy.callCount, 0, 'addDir event should be triggered for each matching directory');

		assert.deepEqual(
			addHandlerSpy
				.getCalls()
				.map((call) => call.args[0].urlPath)
				.sort(),
			['/a', '/b', '/static-assets/c', '/static-assets/d']
		);

		await entryHandler.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it('should emit all file events before ready resolves', async () => {
		// This test verifies the fix for the race condition where ready could fire
		// before all file read operations completed and events were emitted
		const { directory } = createFixture(['file1.txt', 'file2.txt', 'file3.txt', 'file4.txt', 'file5.txt']);

		const eventsReceived = [];
		const entryHandler = new EntryHandler(basename(directory), directory, '*.txt');

		// Track all events as they arrive
		entryHandler.on('add', (entry) => {
			eventsReceived.push({
				path: entry.absolutePath,
				hasContents: entry.contents !== undefined && entry.contents.length > 0,
			});
		});

		// Wait for ready
		await entryHandler.ready;

		// When ready resolves, ALL file events should have been emitted with contents
		assert.equal(eventsReceived.length, 5, 'All 5 file events should have been emitted before ready');

		for (const event of eventsReceived) {
			assert.ok(event.hasContents, `File ${event.path} should have contents when ready resolves`);
		}

		await entryHandler.close();
		rmSync(directory, { recursive: true, force: true });
	});

	describe('pause / resume', () => {
		it('stops emitting while paused and emits only logical additions on resume', async () => {
			const { directory } = createFixture(['a', 'b', 'c']);
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			const addSpy = spy();
			entryHandler.on('add', addSpy);

			await entryHandler.ready;
			const initialAdds = addSpy.callCount;
			assert.equal(initialAdds, 3, 'initial scan should fire 3 add events');

			entryHandler.pause();

			// While paused, adding a file should not emit anything (watcher is closed)
			await writeFile(join(directory, 'd'), 'd');
			await new Promise((r) => setTimeout(r, 100));
			assert.equal(addSpy.callCount, initialAdds, 'no events while paused');

			// Resume — the fresh scan should report only the file created while paused.
			await entryHandler.resume();
			assert.equal(addSpy.callCount, initialAdds + 1, 'resume should emit one add for the new file');
			assert.equal(addSpy.lastCall.args[0].absolutePath, join(directory, 'd'));

			await entryHandler.close();
			rmSync(directory, { recursive: true, force: true });
		});

		it('preserves listener attachments across pause/resume', async () => {
			const { directory } = createFixture(['a']);
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			const allSpy = spy();
			entryHandler.on('all', allSpy);

			await entryHandler.ready;
			const before = allSpy.callCount;
			assert.ok(before >= 1);

			entryHandler.pause();
			await writeFile(join(directory, 'a'), 'changed');
			await entryHandler.resume();

			assert.equal(allSpy.callCount, before + 1, 'all listener still attached after resume');
			assert.equal(allSpy.lastCall.args[0].eventType, 'change');

			await entryHandler.close();
			rmSync(directory, { recursive: true, force: true });
		});

		it('resume is a no-op when not paused', async () => {
			const { directory } = createFixture(['a']);
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			await entryHandler.ready;
			const addSpy = spy();
			entryHandler.on('add', addSpy);

			await entryHandler.resume(); // not paused
			await new Promise((r) => setTimeout(r, 100));
			assert.equal(addSpy.callCount, 0, 'resume without pause should not re-emit');

			await entryHandler.close();
			rmSync(directory, { recursive: true, force: true });
		});

		it('close() while paused awaits the paused watcher teardown', async () => {
			// Exercises the `#pausedClose` branch in close(): pause() kicks off
			// a watcher close, then close() lands before resume() and must await
			// that in-flight teardown rather than resolving early.
			const { directory } = createFixture(['a']);
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			await entryHandler.ready;

			entryHandler.pause();
			// close() called without resume() — exercises #pausedClose path
			await entryHandler.close();
			// if close() resolved, teardown settled without throwing
			rmSync(directory, { recursive: true, force: true });
		});

		it('awaiting `ready` after pause() does not resolve until resume()', async () => {
			// Contract: per pause()'s docstring, awaiting `ready` while paused must
			// wait for resume(). Naive impl (only resetting `ready` in resume) lets
			// an already-resolved `ready` linger across pause and resolve early.
			const { directory } = createFixture(['a']);
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			await entryHandler.ready; // initial ready resolves

			entryHandler.pause();

			let readyResolved = false;
			const readyPromise = entryHandler.ready.then(() => {
				readyResolved = true;
			});

			// Give the microtask queue a chance to settle a stale resolved promise.
			await new Promise((r) => setTimeout(r, 100));
			assert.equal(readyResolved, false, '`ready` must not resolve while paused');

			await entryHandler.resume();
			await readyPromise;
			assert.equal(readyResolved, true, '`ready` resolves after resume()');

			await entryHandler.close();
			rmSync(directory, { recursive: true, force: true });
		});
	});

	describe('polling fallback on watcher exhaustion', () => {
		// harper#488: when the underlying chokidar watcher emits ENOSPC/EMFILE,
		// the EntryHandler should re-open with polling rather than surfacing the
		// error to consumers. EntryHandler's recovery path uses #watch() (which
		// awaits the old watcher's close then checks #closed), structurally
		// different from OptionsWatcher/RootConfigWatcher's explicit
		// close().catch().finally() chain — so it needs its own coverage.

		it('falls back to polling on ENOSPC and continues to receive change events', async () => {
			const { directory } = createFixture(['a.txt']);
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			await entryHandler.ready;

			const errorSpy = spy();
			entryHandler.on('error', errorSpy);

			assert.equal(entryHandler._usingPollingForTests, false);
			const recoveryEntries = [];
			entryHandler.on('all', (entry) => recoveryEntries.push(entry));
			const recoveryReady = once(entryHandler, 'ready');

			entryHandler._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'ENOSPC' }));

			// Allow the close+reopen-with-polling to settle.
			await waitFor(() => entryHandler._usingPollingForTests === true, 2000);
			await recoveryReady;
			assert.equal(entryHandler._usingPollingForTests, true);
			assert.equal(errorSpy.callCount, 0, 'ENOSPC should be swallowed');
			assert.deepEqual(recoveryEntries, [], 'unchanged entries are not replayed as adds during recovery');

			// The polling watcher should pick up subsequent file writes; default
			// directory polling interval is 3s, so allow up to 5s.
			const addSpy = spy();
			entryHandler.on('add', addSpy);
			await writeFile(join(directory, 'b.txt'), 'b');
			await waitFor(() => addSpy.callCount >= 1, 5000);
			assert.ok(addSpy.callCount >= 1, 'polling watcher should fire add');

			entryHandler.close();
			rmSync(directory, { recursive: true, force: true });
		}).timeout(8000);

		it('propagates non-exhaustion errors and does not fall back', async () => {
			const { directory } = createFixture(['a.txt']);
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			await entryHandler.ready;

			const errorSpy = spy();
			entryHandler.on('error', errorSpy);

			entryHandler._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'EACCES' }));
			await new Promise((r) => setTimeout(r, 20));

			assert.equal(entryHandler._usingPollingForTests, false);
			assert.equal(errorSpy.callCount, 1, 'non-exhaustion error should propagate');

			entryHandler.close();
			rmSync(directory, { recursive: true, force: true });
		});

		it('does not treat an exhaustion-shaped consumer exception as a watcher failure', async () => {
			const { directory } = createFixture(['a.txt']);
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			await entryHandler.ready;

			const errors = [];
			entryHandler.on('error', (error) => errors.push(error));
			entryHandler.on('change', () => {
				throw Object.assign(new Error('consumer failed'), { code: 'ENOSPC' });
			});

			await writeFile(join(directory, 'a.txt'), 'changed');
			await waitFor(() => errors.length === 1);
			assert.equal(entryHandler._usingPollingForTests, false);

			await entryHandler.close();
			rmSync(directory, { recursive: true, force: true });
		});

		it('rejects a paused readiness latch when the handler closes', async () => {
			const { directory } = createFixture(['a.txt']);
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			await entryHandler.ready;
			entryHandler.pause();
			const pausedReady = entryHandler.ready;

			await entryHandler.close();
			await assert.rejects(pausedReady, /closed before becoming ready/);
			rmSync(directory, { recursive: true, force: true });
		});

		it('swallows additional exhaustion errors during recovery', async () => {
			const { directory } = createFixture(['a.txt']);
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			await entryHandler.ready;

			const errorSpy = spy();
			entryHandler.on('error', errorSpy);

			const enospc = () => Object.assign(new Error('boom'), { code: 'ENOSPC' });
			entryHandler._simulateWatcherErrorForTests(enospc());
			entryHandler._simulateWatcherErrorForTests(enospc());
			entryHandler._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'EMFILE' }));

			await waitFor(() => entryHandler._usingPollingForTests === true, 1000);
			assert.equal(errorSpy.callCount, 0, 'all exhaustion errors should be swallowed');

			entryHandler.close();
			rmSync(directory, { recursive: true, force: true });
		});

		it('does not reopen watcher if close() is called during recovery', async () => {
			// EntryHandler's recovery path: #handleError calls `void this.#watch()`,
			// which does `await this.#watcher?.close(); if (this.#closed) return`.
			// If close() lands between the ENOSPC and #watch()'s post-await check,
			// the new chokidar watcher must not be installed.
			const { directory } = createFixture(['a.txt']);
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			await entryHandler.ready;

			assert.equal(entryHandler._openCountForTests, 1, 'one initial open');

			// Trigger the fallback path, then immediately close before the inner
			// `await this.#watcher.close()` resolves.
			entryHandler._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'ENOSPC' }));
			entryHandler.close();

			// Allow plenty of time for the would-be reopen to (not) happen.
			await new Promise((r) => setTimeout(r, 200));

			assert.equal(entryHandler._openCountForTests, 1, 'reopen must be suppressed by the close-during-fallback guard');

			rmSync(directory, { recursive: true, force: true });
		}).timeout(2000);
	});

	describe('ignored paths', () => {
		// These cases ensure the watcher does not consume inotify handles for or fire
		// events from transient artifacts produced by `npm install`, git operations, etc.
		// Background: harper#488 — restart storms driven by these paths can exhaust the
		// system file-watcher limit during component deploys.

		it('should ignore top-level node_modules', async () => {
			const { directory } = createFixture([['node_modules', [['pkg', ['index.js']]]], 'app.js']);

			const allHandlerSpy = spy();
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			entryHandler.on('all', allHandlerSpy);

			await entryHandler.ready;

			const paths = allHandlerSpy.getCalls().map((call) => call.args[0].urlPath);
			assert.ok(
				paths.every((p) => !p.includes('node_modules')),
				`no event should reference node_modules, got: ${JSON.stringify(paths)}`
			);
			assert.ok(
				paths.some((p) => p === '/app.js'),
				'app.js outside node_modules should still be emitted'
			);

			entryHandler.close();
			rmSync(directory, { recursive: true, force: true });
		});

		it('should ignore nested node_modules', async () => {
			const { directory } = createFixture([['plugin', [['node_modules', [['dep', ['index.js']]]], 'main.js']]]);

			const allHandlerSpy = spy();
			const entryHandler = new EntryHandler(basename(directory), directory, 'plugin/**/*');
			entryHandler.on('all', allHandlerSpy);

			await entryHandler.ready;

			const paths = allHandlerSpy.getCalls().map((call) => call.args[0].urlPath);
			assert.ok(
				paths.every((p) => !p.includes('node_modules')),
				`no event should reference node_modules, got: ${JSON.stringify(paths)}`
			);
			assert.ok(
				paths.some((p) => p.endsWith('main.js')),
				'plugin/main.js should still be emitted'
			);

			entryHandler.close();
			rmSync(directory, { recursive: true, force: true });
		});

		it('should ignore .git directory', async () => {
			const { directory } = createFixture([['.git', ['HEAD', 'config']], 'app.js']);

			const allHandlerSpy = spy();
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			entryHandler.on('all', allHandlerSpy);

			await entryHandler.ready;

			const paths = allHandlerSpy.getCalls().map((call) => call.args[0].urlPath);
			assert.ok(
				paths.every((p) => !p.includes('.git')),
				`no event should reference .git, got: ${JSON.stringify(paths)}`
			);

			entryHandler.close();
			rmSync(directory, { recursive: true, force: true });
		});

		it('should ignore npm atomic-rename temp directories (.tmp-*)', async () => {
			const { directory } = createFixture([['.tmp-12345', ['package.json']], 'app.js']);

			const allHandlerSpy = spy();
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			entryHandler.on('all', allHandlerSpy);

			await entryHandler.ready;

			const paths = allHandlerSpy.getCalls().map((call) => call.args[0].urlPath);
			assert.ok(
				paths.every((p) => !p.includes('.tmp-')),
				`no event should reference .tmp- dirs, got: ${JSON.stringify(paths)}`
			);

			entryHandler.close();
			rmSync(directory, { recursive: true, force: true });
		});

		it('should ignore package-manager log files', async () => {
			const { directory } = createFixture([
				'app.js',
				'npm-debug.log',
				'yarn-debug.log',
				'yarn-error.log',
				'pnpm-debug.log',
			]);

			const allHandlerSpy = spy();
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			entryHandler.on('all', allHandlerSpy);

			await entryHandler.ready;

			const paths = allHandlerSpy.getCalls().map((call) => call.args[0].urlPath);
			assert.ok(
				paths.every((p) => !p.endsWith('.log')),
				`no event should reference a .log file, got: ${JSON.stringify(paths)}`
			);
			assert.ok(
				paths.some((p) => p === '/app.js'),
				'app.js should still be emitted'
			);

			entryHandler.close();
			rmSync(directory, { recursive: true, force: true });
		});

		it('should not over-match similar names (prefix and suffix)', async () => {
			// The leading-and-trailing segment anchors in the ignored regex must not match
			// substrings on either side. Directories like `notnode_modules` (prefix) and
			// `node_modules_not` (suffix), and files like `npm-debug.log.txt`, are real user
			// paths and must be watched.
			const { directory } = createFixture([
				['notnode_modules', ['data.json']],
				['node_modules_not', ['data.json']],
				'npm-debug.log.txt',
				'app.js',
			]);

			const allHandlerSpy = spy();
			const entryHandler = new EntryHandler(basename(directory), directory, '**/*');
			entryHandler.on('all', allHandlerSpy);

			await entryHandler.ready;

			const paths = allHandlerSpy.getCalls().map((call) => call.args[0].urlPath);
			assert.ok(
				paths.some((p) => p.includes('notnode_modules')),
				`event for notnode_modules should be emitted, got: ${JSON.stringify(paths)}`
			);
			assert.ok(
				paths.some((p) => p.includes('node_modules_not')),
				`event for node_modules_not should be emitted, got: ${JSON.stringify(paths)}`
			);
			assert.ok(
				paths.some((p) => p === '/npm-debug.log.txt'),
				`event for npm-debug.log.txt should be emitted, got: ${JSON.stringify(paths)}`
			);

			entryHandler.close();
			rmSync(directory, { recursive: true, force: true });
		});
	});
});
