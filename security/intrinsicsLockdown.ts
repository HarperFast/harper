export type Lockdown = 'none' | 'freeze' | 'freeze-after-load' | 'seal' | 'seal-after-load' | 'ses';

const INTRINSIC_NAMES = [
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
const currentIntrinsics = () => INTRINSIC_NAMES.map((name) => globalThis[name]);
// A component may replace one of these globals while it loads; literals, functions and async functions keep using
// the originals, so seal modes capture them, and `Object.seal` itself, at import.
const realmIntrinsics = [Function, ...currentIntrinsics()];
const { seal } = Object;

/** An unrecognized mode freezes eagerly: config values are not validated, so a typo fails closed. */
export function lockDownIntrinsics(
	mode: Exclude<Lockdown, 'none' | 'ses'>,
	whenLoaded: Promise<unknown>
): Promise<void> | undefined {
	preventFunctionConstructor();
	const lockDown = mode === 'seal' || mode === 'seal-after-load' ? sealIntrinsics : freezeIntrinsics;
	// a rejected start is reported by the thread server and never serves, so there is nothing left to lock
	if (mode === 'freeze-after-load' || mode === 'seal-after-load') return whenLoaded.then(lockDown, () => {});
	lockDown();
}

function preventFunctionConstructor() {
	Function.prototype.constructor = function () {}; // prevent this from being used to eval data in a parent context
}

// seal only, never read-only: security/DESIGN.md has the V8 cost
function sealIntrinsics() {
	const sealWithPrototype = (intrinsic) => {
		seal(intrinsic);
		seal(intrinsic?.prototype);
	};
	// originals first: a getter a component put on one of these globals may throw
	realmIntrinsics.forEach(sealWithPrototype);
	const sealed = new Set(realmIntrinsics);
	for (const intrinsic of [globalThis.Function, ...currentIntrinsics()]) {
		if (!sealed.has(intrinsic)) sealWithPrototype(intrinsic);
	}
}

function freezeIntrinsics() {
	overridableProperty(Object.prototype, 'toString');
	overridableProperty(Object.prototype, 'valueOf');
	overridableProperty(Object.prototype, 'hasOwnProperty');
	overridableProperty(Object.prototype, 'constructor');
	overridableProperty(Promise.prototype, 'then');
	overridableProperty(Date, 'now');
	for (const name of ['get', 'set', 'has', 'delete', 'clear', 'forEach', 'entries', 'keys', 'values']) {
		overridableProperty(Map.prototype, name);
	}
	// current globals only: freezing a replaced original would skip the overridable accessors above
	for (const intrinsic of currentIntrinsics()) {
		Object.freeze(intrinsic);
		Object.freeze((intrinsic as any)?.prototype);
	}
	Object.freeze(Function);
}

/**
 * This can redefine a property into a getter/setter that will allow derivatives of a prototype to assign
 * a value to the property without incurring an error from the property being frozen and readonly.
 * @param target
 * @param name
 * @param value
 */
function overridableProperty(target, name, value = target[name]) {
	Object.defineProperty(target, name, {
		get() {
			return value;
		},
		set(value) {
			Object.defineProperty(this, name, {
				value,
				configurable: true,
				enumerable: true,
				writable: true,
			});
		},
	});
}
