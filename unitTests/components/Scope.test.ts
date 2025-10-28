import { Scope, MissingDefaultFilesOptionError } from '@/components/Scope';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { stringify } from 'yaml';
import { spy } from 'sinon';
import { OptionsWatcher } from '@/components/OptionsWatcher';
import { Resources } from '@/resources/Resources';
import { EntryHandler } from '@/components/EntryHandler';
import { restartNeeded, resetRestartNeeded } from '@/components/requestRestart';
import { writeFile } from 'node:fs/promises';
import { waitFor } from './waitFor';

describe('Scope', () => {
	beforeEach(() => {
		this.resources = new Resources();
		this.server = {};
		this.directory = mkdtempSync(join(tmpdir(), 'harper.unit-test.scope-'));
		this.name = basename(this.directory);
		this.configFilePath = join(this.directory, 'config.yaml');
		this.testFilePath = join(this.directory, 'test.js');
		writeFileSync(this.testFilePath, '"foo";');
		resetRestartNeeded();
	});

	afterEach(() => {
		resetRestartNeeded();
		try {
			rmSync(this.directory, { recursive: true, force: true });
			// eslint-disable-next-line sonarjs/no-ignored-exceptions
		} catch (err) {
			// best effort to clean up - but doesn't matter too much since this is a temp directory
		}
	});

	it('should create a default entry handler', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.name]: { files: 'test.js' } }));

		const scope = new Scope(this.name, this.directory, this.configFilePath, this.resources, this.server);

		const readySpy = spy();
		scope.on('ready', readySpy);

		await scope.ready;

		assert.ok(readySpy.calledOnce, 'ready event should be emitted once');

		assert.ok(scope instanceof EventEmitter, 'Scope should be an instance of EventEmitter');
		assert.ok(scope.options instanceof OptionsWatcher, 'Scope should have an OptionsWatcher instance');
		assert.ok(scope.resources instanceof Resources, 'Scope should have a resources property of type Map');
		assert.ok(scope.server !== undefined, 'Scope should have a server property');

		// Even though scope is ready, we haven't provided an entry handler yet so modifying a file matched by files option should not request a restart
		await writeFile(this.testFilePath, '"bar";');
		assert.equal(restartNeeded(), false, 'requestRestart should not be called');

		const entryHandlerNoArgs = scope.handleEntry();
		assert.ok(entryHandlerNoArgs instanceof EntryHandler, 'Entry handler should be created');

		// Now, since there is not entry handler function, modifying the file should request a restart
		await writeFile(this.testFilePath, '"baz";');
		await waitFor(() => restartNeeded());
		assert.equal(restartNeeded(), true, 'requestRestart should be called');

		// even though it doesn't do anything this counts as an all handler
		const entryHandlerFunctionArg = scope.handleEntry(() => {});
		assert.ok(entryHandlerFunctionArg instanceof EntryHandler, 'Entry handler should be created');

		assert.deepEqual(entryHandlerNoArgs, entryHandlerFunctionArg, 'Entry handlers should be the same');

		const scopeCloseSpy = spy();
		scope.on('close', scopeCloseSpy);

		const scopeOptionsCloseSpy = spy();
		scope.options.on('close', scopeOptionsCloseSpy);

		const entryHandlerCloseSpy = spy();
		entryHandlerNoArgs.on('close', entryHandlerCloseSpy);

		scope.close();
		assert.equal(scopeCloseSpy.callCount, 1, 'close event should be emitted once');
		assert.equal(scopeOptionsCloseSpy.callCount, 1, 'close event for options should be emitted once');
		assert.equal(entryHandlerCloseSpy.callCount, 1, 'close event for entry handler should be emitted once');
	});

	it('should create a default entry handler with urlPath', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.name]: { files: 'test.js', urlPath: 'abc' } }));

		const scope = new Scope(this.name, this.directory, this.configFilePath, this.resources, this.server);

		const readySpy = spy();
		scope.on('ready', readySpy);

		await scope.ready;

		assert.ok(readySpy.calledOnce, 'ready event should be emitted once');

		assert.ok(scope instanceof EventEmitter, 'Scope should be an instance of EventEmitter');
		assert.ok(scope.options instanceof OptionsWatcher, 'Scope should have an OptionsWatcher instance');
		assert.ok(scope.resources instanceof Resources, 'Scope should have a resources property of type Map');
		assert.ok(scope.server !== undefined, 'Scope should have a server property');

		const handleEntrySpy = spy();
		const entryHandler = scope.handleEntry(handleEntrySpy);
		assert.ok(entryHandler instanceof EntryHandler, 'Entry handler should be created');

		await writeFile(this.testFilePath, '"foo";');

		await waitFor(() => handleEntrySpy.callCount > 0);
		const callArgs = handleEntrySpy.getCall(0).args[0];
		assert.equal(callArgs.eventType, 'add', 'handleEntry argument `eventType` should be `add`');
		assert.equal(callArgs.entryType, 'file', 'handleEntry argument `entryType` should be `file`');
		assert.equal(
			callArgs.absolutePath,
			this.testFilePath,
			'handleEntry argument `absolutePath` should be the test file path'
		);
		assert.equal(callArgs.urlPath, '/abc/test.js', 'handleEntry argument `urlPath` should be `abc/test.js`');
		assert.ok(callArgs.stats !== undefined, 'add event argument `stats` should be defined');
		assert.ok(callArgs.stats.isFile(), 'add event argument `stats` should be a file');

		const scopeCloseSpy = spy();
		scope.on('close', scopeCloseSpy);

		const scopeOptionsCloseSpy = spy();
		scope.options.on('close', scopeOptionsCloseSpy);

		const entryHandlerCloseSpy = spy();
		entryHandler.on('close', entryHandlerCloseSpy);

		scope.close();
		assert.equal(scopeCloseSpy.callCount, 1, 'close event should be emitted once');
		assert.equal(scopeOptionsCloseSpy.callCount, 1, 'close event for options should be emitted once');
		assert.equal(entryHandlerCloseSpy.callCount, 1, 'close event for entry handler should be emitted once');
	});

	it('should call requestRestart if no entry handler is provided', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.name]: { files: '.' } }));

		const scope = new Scope(this.name, this.directory, this.configFilePath, this.resources, this.server);

		await scope.ready;

		await scope.handleEntry().ready;

		assert.equal(restartNeeded(), true, 'requestRestart was called');

		scope.close();
	});

	it('should call requestRestart if no options handler is provided', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.name]: { files: '.' } }));

		const scope = new Scope(this.name, this.directory, this.configFilePath, this.resources, this.server);

		await scope.ready;

		await scope.handleEntry(() => {}).ready;

		assert.equal(restartNeeded(), false, 'requestRestart was not called');

		await writeFile(this.configFilePath, stringify({ [this.name]: { files: '.', foo: 'bar' } }));

		await waitFor(() => restartNeeded());

		assert.equal(restartNeeded(), true, 'requestRestart was called');

		scope.close();
	});

	it('should emit error for missing default entry handler', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.name]: { foo: 'bar' } }));

		const scope = new Scope(this.name, this.directory, this.configFilePath, this.resources, this.server);

		await scope.ready;

		const errorSpy = spy();
		scope.on('error', errorSpy);

		const entryHandler = scope.handleEntry();
		assert.equal(entryHandler, undefined, 'Entry handler should be undefined');

		assert.equal(errorSpy.callCount, 1, 'error event should be emitted once');
		assert.deepEqual(
			errorSpy.getCall(0).args,
			[new MissingDefaultFilesOptionError()],
			'error event should be a missing default files option error'
		);

		scope.handleEntry(() => {});

		assert.equal(errorSpy.callCount, 2, 'error event should be emitted once');
		assert.deepEqual(
			errorSpy.getCall(1).args,
			[new MissingDefaultFilesOptionError()],
			'error event should be a missing default files option error'
		);

		assert.equal(restartNeeded(), false, 'requestRestart should not be called');

		scope.close();
	});

	it('should support custom entry handlers', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.name]: { foo: 'bar' } }));

		const scope = new Scope(this.name, this.directory, this.configFilePath, this.resources, this.server);

		await scope.ready;

		const customEntryHandlerPathOnlyArg = scope.handleEntry('.');
		assert.ok(customEntryHandlerPathOnlyArg instanceof EntryHandler, 'Custom entry handler should be created');

		const customEntryHandlerPathAndFunctionArgs = scope.handleEntry('.', () => {});
		assert.ok(customEntryHandlerPathAndFunctionArgs instanceof EntryHandler, 'Custom entry handler should be created');

		assert.equal(restartNeeded(), false, 'requestRestart should not be called');

		const entryHandleCloseSpy1 = spy();
		const entryHandleCloseSpy2 = spy();

		customEntryHandlerPathOnlyArg.on('close', entryHandleCloseSpy1);
		customEntryHandlerPathAndFunctionArgs.on('close', entryHandleCloseSpy2);

		scope.close();

		assert.equal(entryHandleCloseSpy1.callCount, 1, 'close event for custom entry handler should be emitted once');
		assert.equal(entryHandleCloseSpy2.callCount, 1, 'close event for custom entry handler should be emitted once');
	});
});
