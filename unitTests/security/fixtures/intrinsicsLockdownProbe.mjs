import { parentPort, workerData } from 'node:worker_threads';
import { runInThisContext } from 'node:vm';
import { lockDownIntrinsics } from '#src/security/intrinsicsLockdown';

const LOCKED_NAMES = [
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
const ADD_TARGETS = {
	'Object.prototype': Object.prototype,
	'Array.prototype': Array.prototype,
	'Function.prototype': Function.prototype,
	'Reflect': Reflect,
};
const sloppyAssign = runInThisContext('(function (target, name) { target[name] = true; })');
const describeProperty = (target, name) => {
	const descriptor = Object.getOwnPropertyDescriptor(target, name);
	return { accessor: 'get' in descriptor, writable: descriptor.writable, configurable: descriptor.configurable };
};

function probe(phase) {
	const strictAdd = {};
	const sloppyAdd = {};
	for (const [label, target] of Object.entries(ADD_TARGETS)) {
		const strictName = `${phase}StrictProbe`;
		try {
			target[strictName] = true;
			strictAdd[label] = 'added';
			delete target[strictName];
		} catch (error) {
			strictAdd[label] = error.constructor.name;
		}
		const sloppyName = `${phase}SloppyProbe`;
		sloppyAssign(target, sloppyName);
		sloppyAdd[label] = Object.hasOwn(target, sloppyName) ? 'added' : 'ignored';
		delete target[sloppyName];
	}
	const pollutedName = `${phase}Polluted`;
	Reflect.set(Object.prototype, pollutedName, true);
	const pollutedVisible = {}[pollutedName] === true;
	delete Object.prototype[pollutedName];
	const shadow = {};
	const tryShadow = (label, instance, name) => {
		const replacement = () => 'shadowed';
		try {
			instance[name] = replacement;
			shadow[label] = Object.hasOwn(instance, name) && instance[name] === replacement;
		} catch (error) {
			shadow[label] = error.constructor.name;
		}
	};
	tryShadow('object.toString', {}, 'toString');
	tryShadow('object.hasOwnProperty', {}, 'hasOwnProperty');
	tryShadow('array.push', [], 'push');
	tryShadow('function.call', function () {}, 'call');
	tryShadow('promise.then', Promise.resolve(), 'then');
	tryShadow('map.get', new Map(), 'get');
	tryShadow('date.toJSON', new Date(), 'toJSON');
	return {
		strictAdd,
		sloppyAdd,
		pollutedVisible,
		shadow,
		unsealed: LOCKED_NAMES.filter((name) => {
			const intrinsic = globalThis[name];
			return (
				!Object.isSealed(intrinsic) || (intrinsic.prototype !== undefined && !Object.isSealed(intrinsic.prototype))
			);
		}),
		originalOfReplacedSealed: Object.isSealed(originalWeakRef) && Object.isSealed(originalWeakRef.prototype),
		functionSealed: Object.isSealed(Function),
		functionPrototypeExtensible: Object.isExtensible(Function.prototype),
		frozen: {
			'Object.prototype': Object.isFrozen(Object.prototype),
			'Array.prototype': Object.isFrozen(Array.prototype),
			'Function.prototype': Object.isFrozen(Function.prototype),
		},
		descriptors: {
			'Object.prototype.toString': describeProperty(Object.prototype, 'toString'),
			'Array.prototype.push': describeProperty(Array.prototype, 'push'),
			'Function.prototype.call': describeProperty(Function.prototype, 'call'),
			'Promise.prototype.then': describeProperty(Promise.prototype, 'then'),
			'Map.prototype.get': describeProperty(Map.prototype, 'get'),
			'Math.PI': describeProperty(Math, 'PI'),
		},
		functionConstructorNeutralized: (() => {}).constructor('return 1') === undefined,
	};
}

const originalWeakRef = WeakRef;
globalThis.WeakRef = class ReplacedWeakRef extends WeakRef {};
let markLoaded;
const whenLoaded = new Promise((resolve) => (markLoaded = resolve));
lockDownIntrinsics(workerData.mode, whenLoaded);
const duringLoad = probe('during');
markLoaded();
await whenLoaded;
parentPort.postMessage({ duringLoad, afterLoad: probe('after') });
