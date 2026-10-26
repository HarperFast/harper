export type Lockdown = 'none' | 'freeze' | 'freeze-after-load' | 'seal' | 'seal-after-load' | 'ses';

const currentIntrinsics = () => [
	Object,
	Array,
	Promise,
	BigInt,
	String,
	Number,
	Boolean,
	Symbol,
	RegExp,
	Date,
	Map,
	Set,
	WeakMap,
	WeakSet,
	Math,
	JSON,
	Reflect,
	Atomics,
	SharedArrayBuffer,
	WeakRef,
	FinalizationRegistry,
];
// A component may replace one of these globals while it loads; literals and async functions keep using the original.
const realmIntrinsics = currentIntrinsics();

/** An unrecognized mode freezes eagerly: config values are not validated, so a typo fails closed. */
export function lockDownIntrinsics(mode: Exclude<Lockdown, 'none' | 'ses'>, whenLoaded: Promise<unknown>): void {
	preventFunctionConstructor();
	const lockDown = mode === 'seal' || mode === 'seal-after-load' ? sealIntrinsics : freezeIntrinsics;
	// a rejected start is reported by the thread server and never serves, so there is nothing left to lock
	if (mode === 'freeze-after-load' || mode === 'seal-after-load') whenLoaded.then(lockDown, () => {});
	else lockDown();
}

function preventFunctionConstructor() {
	Function.prototype.constructor = function () {}; // prevent this from being used to eval data in a parent context
}

// Properties must stay writable: a read-only prototype elements kind costs every store into an array hole its V8
// fast path, process-wide (security/DESIGN.md).
function sealIntrinsics() {
	for (const intrinsic of currentIntrinsics().concat(realmIntrinsics)) {
		Object.seal(intrinsic);
		Object.seal((intrinsic as any)?.prototype);
	}
	Object.seal(Function);
	Object.seal(Function.prototype);
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
