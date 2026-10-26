'use strict';

const assert = require('node:assert');
const { join } = require('node:path');
const { Worker } = require('node:worker_threads');

const PROBE = join(__dirname, 'fixtures', 'intrinsicsLockdownProbe.mjs');
const TARGETS = ['Object.prototype', 'Array.prototype', 'Function.prototype', 'Reflect'];
const ALL_LOCKED = [
	'Object',
	'Array',
	'Promise',
	'BigInt',
	'String',
	'Number',
	'Boolean',
	'Symbol',
	'RegExp',
	'Date',
	'Map',
	'Set',
	'WeakMap',
	'WeakSet',
	'Math',
	'JSON',
	'Reflect',
	'Atomics',
	'SharedArrayBuffer',
	'WeakRef',
	'FinalizationRegistry',
];
const SHADOWS = [
	'object.toString',
	'object.hasOwnProperty',
	'array.push',
	'function.call',
	'promise.then',
	'map.get',
	'date.toJSON',
];
const each = (keys, value) =>
	Object.fromEntries(keys.map((key) => [key, typeof value === 'function' ? value(key) : value]));
const data = (writable, configurable) => ({ accessor: false, writable, configurable });
const accessor = { accessor: true, writable: undefined, configurable: false };
const READ_ONLY_PI = data(false, false);

const UNLOCKED = {
	strictAdd: each(TARGETS, 'added'),
	sloppyAdd: each(TARGETS, 'added'),
	pollutedVisible: true,
	shadow: each(SHADOWS, true),
	unsealed: ALL_LOCKED,
	originalOfReplacedSealed: false,
	functionSealed: false,
	functionPrototypeExtensible: true,
	frozen: each(['Object.prototype', 'Array.prototype', 'Function.prototype'], false),
	descriptors: {
		...each(
			[
				'Object.prototype.toString',
				'Array.prototype.push',
				'Function.prototype.call',
				'Promise.prototype.then',
				'Map.prototype.get',
			],
			data(true, true)
		),
		'Math.PI': READ_ONLY_PI,
	},
	functionConstructorNeutralized: true,
};
const SEALED = {
	...UNLOCKED,
	strictAdd: each(TARGETS, 'TypeError'),
	sloppyAdd: each(TARGETS, 'ignored'),
	pollutedVisible: false,
	unsealed: [],
	originalOfReplacedSealed: true,
	functionSealed: true,
	functionPrototypeExtensible: false,
	descriptors: {
		...each(
			[
				'Object.prototype.toString',
				'Array.prototype.push',
				'Function.prototype.call',
				'Promise.prototype.then',
				'Map.prototype.get',
			],
			data(true, false)
		),
		'Math.PI': READ_ONLY_PI,
	},
};
const FROZEN = {
	...UNLOCKED,
	strictAdd: each(TARGETS, (target) => (target === 'Function.prototype' ? 'added' : 'TypeError')),
	sloppyAdd: each(TARGETS, (target) => (target === 'Function.prototype' ? 'added' : 'ignored')),
	pollutedVisible: false,
	shadow: each(SHADOWS, (shadow) => (shadow === 'array.push' || shadow === 'date.toJSON' ? 'TypeError' : true)),
	unsealed: [],
	functionSealed: true,
	frozen: { 'Object.prototype': true, 'Array.prototype': true, 'Function.prototype': false },
	descriptors: {
		'Object.prototype.toString': accessor,
		'Array.prototype.push': data(false, false),
		'Function.prototype.call': data(true, true),
		'Promise.prototype.then': accessor,
		'Map.prototype.get': accessor,
		'Math.PI': READ_ONLY_PI,
	},
};

function probeLockdown(mode) {
	const worker = new Worker(PROBE, { workerData: { mode } });
	let timer;
	return new Promise((resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`lockdown probe for ${String(mode)} reported nothing in 30s`)), 30_000);
		worker.once('message', resolve);
		worker.once('error', reject);
		worker.once('exit', (code) =>
			reject(new Error(`lockdown probe for ${String(mode)} exited ${code} without reporting`))
		);
	}).finally(() => {
		clearTimeout(timer);
		return worker.terminate();
	});
}

describe('lockDownIntrinsics', function () {
	this.timeout(60_000);

	for (const [mode, duringLoad, afterLoad] of [
		['seal', SEALED, SEALED],
		['seal-after-load', UNLOCKED, SEALED],
		['freeze', FROZEN, FROZEN],
		['freeze-after-load', UNLOCKED, FROZEN],
		['typo-after-load', FROZEN, FROZEN],
		[true, FROZEN, FROZEN],
	]) {
		it(`${JSON.stringify(mode)}: ${duringLoad === afterLoad ? 'locks eagerly' : 'locks once loaded'}`, async () => {
			const result = await probeLockdown(mode);
			assert.deepStrictEqual(result.duringLoad, duringLoad, 'during load');
			assert.deepStrictEqual(result.afterLoad, afterLoad, 'after load');
		});
	}
});
