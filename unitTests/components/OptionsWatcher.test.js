/* eslint-disable sonarjs/no-nested-functions */
const { OptionsWatcher } = require('../../components/OptionsWatcher');
const { EventEmitter, once } = require('node:events');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { writeFile, rm } = require('node:fs/promises');
const { stringify } = require('yaml');
const { spy } = require('sinon');

/**
 * This function asserts that an event is emitted.
 * It also allows for triggering the event and performing additional assertions.
 * The `triggerEvent` and `additionalAssertions` parameters can by async.
 * @param {EventEmitter} ee
 * @param {string} event
 * @param {Function} [triggerEvent]
 * @param {Function} [additionalAssertions]
 */
async function assertEvent(ee, event, triggerEvent, additionalAssertions) {
	const eventSpy = spy();
	ee.on(event, eventSpy);
	const eventTriggered = once(ee, event);
	try {
		await triggerEvent?.();
		await eventTriggered;
		await additionalAssertions?.(eventSpy);
	} finally {
		ee.removeListener(event, eventSpy);
	}
}

const NAME = 'test-component';

const OPTIONS = {
	nil: null,
	str: 'foo',
	bool: true,
	num: 100,
	arr: [1, 2, 3],
	obj: {
		nil: null,
		str: 'bar',
		bool: false,
		num: 200,
		arr: [4, 5, 6],
		deep: {
			x: 1,
		},
	},
};

const CONFIG = {
	[NAME]: OPTIONS,
};

function createFixture(config = CONFIG) {
	const fixture = mkdtempSync(join(tmpdir(), 'harper.unit-test.options-watcher-'));
	const configFilePath = join(fixture, 'config.yaml');
	writeFileSync(configFilePath, stringify(config), 'utf-8');

	return { fixture, configFilePath };
}

async function setup() {
	const { fixture, configFilePath } = createFixture();

	const options = new OptionsWatcher(NAME, configFilePath);

	await options.ready();

	return {
		fixture,
		configFilePath,
		options,
	};
}

async function teardown({ fixture, options }) {
	await options.close();
	rmSync(fixture, { force: true, recursive: true });
}

describe('OptionsWatcher', () => {
	it('should instantiate with a file path and emit a ready event', async () => {
		const { fixture, configFilePath } = createFixture();

		const options = new OptionsWatcher(NAME, configFilePath);

		assert.ok(options instanceof EventEmitter, 'OptionsWatcher should be an instance of EventEmitter');

		// The `OptionsWatcher` class emits a `'ready'` event, so assert that using the `assertEvent` utility.
		// The class also includes a `ready()` method that returns a promise tracking the `'ready'` event, that is tested in the next test.
		await assertEvent(options, 'ready', undefined, (eventSpy) => {
			assert.equal(eventSpy.callCount, 1);
			assert.deepEqual(eventSpy.getCall(0).args, [OPTIONS], 'should emit the initial config');
		});

		await teardown({ fixture, options });
	});

	it('should instantiate and emit ready even if the file does not exist', async () => {
		const { fixture, configFilePath } = createFixture();
		rmSync(configFilePath, { force: true });

		const options = new OptionsWatcher(NAME, configFilePath);

		await assertEvent(options, 'ready', undefined, (eventSpy) => {
			assert.equal(eventSpy.callCount, 1);
		});

		assert.equal(options.getAll(), undefined, 'should return undefined if the file does not exist');

		await teardown({ fixture, options });
	});

	it('should await ready event via `ready()` method', async () => {
		const { fixture, configFilePath } = createFixture();

		const options = new OptionsWatcher(NAME, configFilePath);

		// This test is very similar to the `assertEvent` utility (thats also used in the previous test), but we want to ensure that the `ready()` method works as expected.
		// So instead of awaiting the `once(options, 'ready')` promise, await the `ready()` method and ensure the spy is called once.
		const readySpy = spy();
		options.on('ready', readySpy);
		await options.ready();
		assert.equal(readySpy.callCount, 1);

		await teardown({ fixture, options });
	});

	it('should correctly return the initial configuration', async () => {
		const { fixture, options } = await setup();
		const expected = structuredClone(OPTIONS);
		assert.equal(options.get(['nil']), expected.nil, 'should return a top-level null value');
		assert.equal(options.get(['str']), expected.str, 'should return a top-level string value');
		assert.equal(options.get(['bool']), expected.bool, 'should return a top-level boolean value');
		assert.equal(options.get(['num']), expected.num, 'should return a top-level number value');
		assert.deepEqual(options.get(['arr']), expected.arr, 'should return a top-level array value');
		assert.deepEqual(options.get(['obj']), expected.obj, 'should return a top-level object value');
		assert.equal(options.get(['obj', 'nil']), expected.obj.nil, 'should return a nested null value');
		assert.equal(options.get(['obj', 'str']), expected.obj.str, 'should return a nested string value');
		assert.equal(options.get(['obj', 'bool']), expected.obj.bool, 'should return a nested boolean value');
		assert.equal(options.get(['obj', 'num']), expected.obj.num, 'should return a nested number value');
		assert.deepEqual(options.get(['obj', 'arr']), expected.obj.arr, 'should return a nested array value');
		assert.deepEqual(options.get(['obj', 'deep']), expected.obj.deep, 'should return a nested object value');
		assert.equal(options.get(['obj', 'deep', 'x']), expected.obj.deep.x, 'should return a deeply nested value');

		assert.equal(options.get(['nonExistent']), undefined, 'should return undefined for a non-existent property');
		assert.equal(
			options.get(['obj', 'nonExistent']),
			undefined,
			'should return undefined for a non-existent nested property'
		);
		assert.equal(
			options.get(['obj', 'deep', 'nonExistent']),
			undefined,
			'should return undefined for a non-existent deeply nested property'
		);

		assert.deepEqual(options.getAll(), expected, 'should return the entire configuration');

		await teardown({ fixture, options });
	});

	it('should continue to watch if file is removed and recreated', async () => {
		// Detecting file removal and recreation can take some time so increase the timeout
		this.timeout = 3000;

		const { fixture, configFilePath, options } = await setup();

		const expected = structuredClone(OPTIONS);

		await assertEvent(
			options,
			'remove',
			() => rm(configFilePath, { force: true }),
			(removeSpy) => {
				assert.equal(removeSpy.callCount, 1);
				assert.equal(options.getAll(), undefined, 'should return undefined after file removal');
			}
		);

		await assertEvent(
			options,
			'ready',
			() => writeFile(configFilePath, stringify(CONFIG), 'utf-8'),
			(readySpy) => {
				assert.equal(readySpy.callCount, 1);
				assert.deepEqual(options.getAll(), expected, 'should return the configuration after file recreation');
			}
		);

		await teardown({ fixture, options });
	});

	it('should emit a remove event if the respective name is deleted', async () => {
		const config = {
			foo: { x: 1 },
			bar: { x: 1 },
		};
		const { fixture, configFilePath } = createFixture(config);

		const options = new OptionsWatcher('foo', configFilePath);
		await options.ready();

		const removeSpy = spy();
		options.on('remove', removeSpy);

		const removeEvent = once(options, 'remove');

		// then delete the 'foo' part and write again.
		// if the watcher is working correctly, it should only emit a change event for the 'foo' part
		delete config.foo;
		await writeFile(configFilePath, stringify(config), 'utf-8');

		await removeEvent;

		assert.equal(removeSpy.callCount, 1);

		await teardown({ fixture, options });
	});

	describe('change event from modifying underlying config file', () => {
		beforeEach(async () => {
			const { fixture, configFilePath, options } = await setup();
			this.fixture = fixture;
			this.configFilePath = configFilePath;
			this.options = options;
			this.expected = structuredClone(OPTIONS);
		});

		afterEach(async () => {
			await teardown({ fixture: this.fixture, options: this.options });
		});

		describe('with top-level primitive (string, number, boolean, null) and array values', () => {
			it('should handle updating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.nil = 'not null';
						this.expected.str = null;
						this.expected.bool = false;
						this.expected.num = 200;
						this.expected.arr = [1, 2, 3, 4];
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 5);
						assert.deepEqual(changeSpy.getCall(0).args, [['nil'], this.expected.nil, this.expected]);
						assert.deepEqual(changeSpy.getCall(1).args, [['str'], this.expected.str, this.expected]);
						assert.deepEqual(changeSpy.getCall(2).args, [['bool'], this.expected.bool, this.expected]);
						assert.deepEqual(changeSpy.getCall(3).args, [['num'], this.expected.num, this.expected]);
						assert.deepEqual(changeSpy.getCall(4).args, [['arr'], this.expected.arr, this.expected]);
					}
				));

			it('should handle creating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.newNil = 'null';
						this.expected.newStr = 'foo';
						this.expected.newBool = true;
						this.expected.newNum = 300;
						this.expected.newArr = [1, 2, 3];
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 5);
						assert.deepEqual(changeSpy.getCall(0).args, [['newNil'], this.expected.newNil, this.expected]);
						assert.deepEqual(changeSpy.getCall(1).args, [['newStr'], this.expected.newStr, this.expected]);
						assert.deepEqual(changeSpy.getCall(2).args, [['newBool'], this.expected.newBool, this.expected]);
						assert.deepEqual(changeSpy.getCall(3).args, [['newNum'], this.expected.newNum, this.expected]);
						assert.deepEqual(changeSpy.getCall(4).args, [['newArr'], this.expected.newArr, this.expected]);
					}
				));

			it('should handle deleting', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.nil = undefined;
						this.expected.str = undefined;
						this.expected.bool = undefined;
						this.expected.num = undefined;
						this.expected.arr = undefined;

						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 5);
						assert.deepEqual(changeSpy.getCall(0).args, [['nil'], this.expected.nil, this.expected]);
						assert.deepEqual(changeSpy.getCall(1).args, [['str'], this.expected.str, this.expected]);
						assert.deepEqual(changeSpy.getCall(2).args, [['bool'], this.expected.bool, this.expected]);
						assert.deepEqual(changeSpy.getCall(3).args, [['num'], this.expected.num, this.expected]);
						assert.deepEqual(changeSpy.getCall(4).args, [['arr'], this.expected.arr, this.expected]);
					}
				));
		});

		describe('with nested primitives (string, number, boolean, null) and array values', () => {
			it('should handle updating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj.nil = 'not null';
						this.expected.obj.str = null;
						this.expected.obj.bool = true;
						this.expected.obj.num = 400;
						this.expected.obj.arr = [4, 5, 6, 7];
						this.expected.obj.deep.x = 2;
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 6);
						assert.deepEqual(changeSpy.getCall(0).args, [['obj', 'nil'], this.expected.obj.nil, this.expected]);
						assert.deepEqual(changeSpy.getCall(1).args, [['obj', 'str'], this.expected.obj.str, this.expected]);
						assert.deepEqual(changeSpy.getCall(2).args, [['obj', 'bool'], this.expected.obj.bool, this.expected]);
						assert.deepEqual(changeSpy.getCall(3).args, [['obj', 'num'], this.expected.obj.num, this.expected]);
						assert.deepEqual(changeSpy.getCall(4).args, [['obj', 'arr'], this.expected.obj.arr, this.expected]);
						assert.deepEqual(changeSpy.getCall(5).args, [
							['obj', 'deep', 'x'],
							this.expected.obj.deep.x,
							this.expected,
						]);
					}
				));

			it('should handle creating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj.newNil = null;
						this.expected.obj.newStr = 'foo';
						this.expected.obj.newBool = true;
						this.expected.obj.newNum = 300;
						this.expected.obj.newArr = [1, 2, 3];
						this.expected.obj.deep.newVal = 'newVal';
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 6);
						assert.deepEqual(changeSpy.getCall(0).args, [
							['obj', 'deep', 'newVal'],
							this.expected.obj.deep.newVal,
							this.expected,
						]);
						assert.deepEqual(changeSpy.getCall(1).args, [['obj', 'newNil'], this.expected.obj.newNil, this.expected]);
						assert.deepEqual(changeSpy.getCall(2).args, [['obj', 'newStr'], this.expected.obj.newStr, this.expected]);
						assert.deepEqual(changeSpy.getCall(3).args, [['obj', 'newBool'], this.expected.obj.newBool, this.expected]);
						assert.deepEqual(changeSpy.getCall(4).args, [['obj', 'newNum'], this.expected.obj.newNum, this.expected]);
						assert.deepEqual(changeSpy.getCall(5).args, [['obj', 'newArr'], this.expected.obj.newArr, this.expected]);
					}
				));

			it('should handle deleting', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj.nil = undefined;
						this.expected.obj.str = undefined;
						this.expected.obj.bool = undefined;
						this.expected.obj.num = undefined;
						this.expected.obj.arr = undefined;
						this.expected.obj.deep.x = undefined;

						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 6);
						assert.deepEqual(changeSpy.getCall(0).args, [['obj', 'nil'], this.expected.obj.nil, this.expected]);
						assert.deepEqual(changeSpy.getCall(1).args, [['obj', 'str'], this.expected.obj.str, this.expected]);
						assert.deepEqual(changeSpy.getCall(2).args, [['obj', 'bool'], this.expected.obj.bool, this.expected]);
						assert.deepEqual(changeSpy.getCall(3).args, [['obj', 'num'], this.expected.obj.num, this.expected]);
						assert.deepEqual(changeSpy.getCall(4).args, [['obj', 'arr'], this.expected.obj.arr, this.expected]);
						assert.deepEqual(changeSpy.getCall(5).args, [
							['obj', 'deep', 'x'],
							this.expected.obj.deep.x,
							this.expected,
						]);
					}
				));
		});

		describe('with top-level object values', () => {
			it('should handle updating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj = {
							arr: undefined,
							bool: undefined,
							deep: undefined,
							foo: 'bar',
							nil: undefined,
							num: undefined,
							str: undefined,
						};
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						// "Updating" an object is actually the same as updating/removing/creating properties of the existing object
						// So instead of just one change event, we'll get multiple change events for each property
						assert.equal(changeSpy.callCount, 7);
						// these all get "removed"
						assert.deepEqual(changeSpy.getCall(0).args, [['obj', 'nil'], this.expected.obj.nil, this.expected]);
						assert.deepEqual(changeSpy.getCall(1).args, [['obj', 'str'], this.expected.obj.str, this.expected]);
						assert.deepEqual(changeSpy.getCall(2).args, [['obj', 'bool'], this.expected.obj.bool, this.expected]);
						assert.deepEqual(changeSpy.getCall(3).args, [['obj', 'num'], this.expected.obj.num, this.expected]);
						assert.deepEqual(changeSpy.getCall(4).args, [['obj', 'arr'], this.expected.obj.arr, this.expected]);
						assert.deepEqual(changeSpy.getCall(5).args, [['obj', 'deep'], this.expected.obj.deep, this.expected]);
						// this is the "new" property
						assert.deepEqual(changeSpy.getCall(6).args, [['obj', 'foo'], this.expected.obj.foo, this.expected]);
					}
				));

			it('should handle creating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.newObj = { foo: 'bar' };
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 1);
						assert.deepEqual(changeSpy.getCall(0).args, [['newObj'], this.expected.newObj, this.expected]);
					}
				));

			it('should handle deleting', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj = undefined;
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 1);
						assert.deepEqual(changeSpy.getCall(0).args, [['obj'], this.expected.obj, this.expected]);
					}
				));
		});

		describe('with nested object values', () => {
			it('should handle updating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj.deep = { foo: 'bar', x: undefined };
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 2);
						assert.deepEqual(changeSpy.getCall(0).args, [
							['obj', 'deep', 'x'],
							this.expected.obj.deep.x,
							this.expected,
						]);
						assert.deepEqual(changeSpy.getCall(1).args, [
							['obj', 'deep', 'foo'],
							this.expected.obj.deep.foo,
							this.expected,
						]);
					}
				));

			it('should handle creating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj.newObj = { foo: 'bar' };
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 1);
						assert.deepEqual(changeSpy.getCall(0).args, [['obj', 'newObj'], this.expected.obj.newObj, this.expected]);
					}
				));

			it('should handle deleting', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj.deep = undefined;
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 1);
						assert.deepEqual(changeSpy.getCall(0).args, [['obj', 'deep'], this.expected.obj.deep, this.expected]);
					}
				));
		});

		it('should handle updating an array to an object and vice versa', () =>
			assertEvent(
				this.options,
				'change',
				async () => {
					this.expected.arr = { foo: 'bar' };
					this.expected.obj = [1, 2, 3];
					await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
				},
				(changeSpy) => {
					assert.equal(changeSpy.callCount, 2);
					assert.deepEqual(changeSpy.getCall(0).args, [['arr'], this.expected.arr, this.expected]);
					assert.deepEqual(changeSpy.getCall(1).args, [['obj'], this.expected.obj, this.expected]);
				}
			));
	});
});
