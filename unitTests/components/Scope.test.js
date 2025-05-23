const { Scope, MissingDefaultEntryHandlerError } = require('../../components/Scope');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const { join, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { stringify } = require('yaml');
const { spy } = require('sinon');
const { OptionsWatcher } = require('../../components/OptionsWatcher');
const { Resources } = require('../../resources/Resources');
const { EntryHandler } = require('../../components/EntryHandler');
const { restartNeeded, resetRestartNeeded } = require('../../components/requestRestart');
const { writeFile } = require('node:fs/promises');
const { waitFor } = require('./waitFor.js');

describe('Scope', () => {
	beforeEach(() => {
		this.resources = new Resources();
		this.server = {};
		this.directory = mkdtempSync(join(tmpdir(), 'harper.unit-test.scope-'));
		this.name = basename(this.directory);
		this.configFilePath = join(this.directory, 'config.yaml');
		resetRestartNeeded();
	});

	afterEach(() => {
		resetRestartNeeded();
		rmSync(this.directory, { recursive: true, force: true });
	});

	it('should create a default entry handler', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.name]: { files: '.' } }));

		const scope = new Scope(this.name, this.directory, this.configFilePath, this.resources, this.server);

		const readySpy = spy();
		scope.on('ready', readySpy);

		await scope.ready();

		assert.ok(readySpy.calledOnce, 'ready event should be emitted once');

		assert.ok(scope instanceof EventEmitter, 'Scope should be an instance of EventEmitter');
		assert.ok(scope.options instanceof OptionsWatcher, 'Scope should have an OptionsWatcher instance');
		assert.ok(scope.resources instanceof Resources, 'Scope should have a resources property of type Map');
		assert.ok(scope.server !== undefined, 'Scope should have a server property');

		const entryHandlerNoArgs = scope.handleEntry();
		assert.ok(entryHandlerNoArgs instanceof EntryHandler, 'Entry handler should be created');

		// even though it doesn't do anything this counts as an all handler
		const entryHandlerFunctionArg = scope.handleEntry(() => {});
		assert.ok(entryHandlerFunctionArg instanceof EntryHandler, 'Entry handler should be created');

		assert.deepEqual(entryHandlerNoArgs, entryHandlerFunctionArg, 'Entry handlers should be the same');

		assert.equal(restartNeeded(), false, 'requestRestart should not be called');

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

	it('should call requestRestart if no entry handler is provided', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.name]: { files: '.' } }));

		const scope = new Scope(this.name, this.directory, this.configFilePath, this.resources, this.server);

		await scope.ready();

		await scope.handleEntry().ready();

		assert.equal(restartNeeded(), true, 'requestRestart was called');

		scope.close();
	});

	it('should call requestRestart if no options handler is provided', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.name]: { files: '.' } }));

		const scope = new Scope(this.name, this.directory, this.configFilePath, this.resources, this.server);

		await scope.ready();

		await scope.handleEntry(() => {}).ready();

		assert.equal(restartNeeded(), false, 'requestRestart was not called');

		await writeFile(this.configFilePath, stringify({ [this.name]: { files: '.', foo: 'bar' } }));

		await waitFor(() => restartNeeded());

		assert.equal(restartNeeded(), true, 'requestRestart was called');

		scope.close();
	});

	it('should emit error for missing default entry handler', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.name]: { foo: 'bar' } }));

		const scope = new Scope(this.name, this.directory, this.configFilePath, this.resources, this.server);

		await scope.ready();

		const errorSpy = spy();
		scope.on('error', errorSpy);

		const entryHandler = scope.handleEntry();
		assert.equal(entryHandler, undefined, 'Entry handler should be undefined');

		assert.equal(errorSpy.callCount, 1, 'error event should be emitted once');
		assert.deepEqual(
			errorSpy.getCall(0).args,
			[new MissingDefaultEntryHandlerError()],
			'error event should be a missing default entry handler error'
		);

		scope.handleEntry(() => {});

		assert.equal(errorSpy.callCount, 2, 'error event should be emitted once');
		assert.deepEqual(
			errorSpy.getCall(1).args,
			[new MissingDefaultEntryHandlerError()],
			'error event should be a missing default entry handler error'
		);

		assert.equal(restartNeeded(), false, 'requestRestart should not be called');

		scope.close();
	});

	it('should support custom entry handlers', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.name]: { foo: 'bar' } }));

		const scope = new Scope(this.name, this.directory, this.configFilePath, this.resources, this.server);

		await scope.ready();

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
