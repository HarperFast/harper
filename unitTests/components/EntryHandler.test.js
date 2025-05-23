const { EntryHandler } = require('../../components/EntryHandler');
const { EventEmitter, once } = require('node:events');
const assert = require('node:assert/strict');
const { join, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { writeFile, mkdir } = require('node:fs/promises');
const { spy } = require('sinon');
const { waitFor } = require('./waitFor.js');

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
		rmSync(this.directory, { recursive: true, force: true });
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

		const closeEvent = once(entryHandler, 'close');
		entryHandler.close();
		await closeEvent;
		assert.equal(closeEventSpy.callCount, 1, 'close event should be triggered once');

		assert.equal(entryHandler.listenerCount('ready'), 0, 'ready event listener should be removed');
		assert.equal(entryHandler.listenerCount('close'), 0, 'close event listener should be removed');
		assert.equal(entryHandler.listenerCount('all'), 0, 'all event listener should be removed');
		assert.equal(entryHandler.listenerCount('add'), 0, 'add event listener should be removed');
		assert.equal(entryHandler.listenerCount('unlink'), 0, 'unlink event listener should be removed');
		assert.equal(entryHandler.listenerCount('addDir'), 0, 'addDir event listener should be removed');
		assert.equal(entryHandler.listenerCount('unlinkDir'), 0, 'unlinkDir event listener should be removed');
	});

	it('should await ready event via `ready()` method', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, './');

		const readyEventSpy = spy();
		entryHandler.on('ready', readyEventSpy);
		await entryHandler.ready();
		assert.equal(readyEventSpy.callCount, 1, 'ready event should be triggered once');

		entryHandler.close();
	});

	it('should emit file change events', async () => {
		const entryHandler = new EntryHandler(this.name, this.directory, './a');
		await entryHandler.ready();

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

		entryHandler.close();
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

		await entryHandler.update('b');

		await waitFor(() => allHandlerSpy.callCount === 1);

		assert.equal(readyEventSpy.callCount, 1, 'ready event should be triggered again once');
		assert.equal(allHandlerSpy.callCount, 1, 'all event should be triggered for each new entry');
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

		const closeEvent = once(entryHandler, 'close');
		entryHandler.close();
		await closeEvent;
		assert.equal(closeEventSpy.callCount, 1, 'close event should be triggered once');
		assert.equal(entryHandler.listenerCount('ready'), 0, 'ready event listener should be removed');
		assert.equal(entryHandler.listenerCount('close'), 0, 'close event listener should be removed');
		assert.equal(entryHandler.listenerCount('all'), 0, 'all event listener should be removed');
		assert.equal(entryHandler.listenerCount('add'), 0, 'add event listener should be removed');
		assert.equal(entryHandler.listenerCount('addDir'), 0, 'addDir event listener should be removed');
	});
});
