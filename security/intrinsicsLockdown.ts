export type Lockdown = 'none' | 'freeze' | 'freeze-after-load' | 'seal' | 'seal-after-load' | 'ses';

const LOCKED_INTRINSICS = [
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

/**
 * Applies a non-SES `applications.lockdown` mode to this realm's intrinsics. Values are matched exactly: anything
 * but the two seal modes freezes, and only the two after-load modes wait for `whenLoaded`.
 */
export function lockDownIntrinsics(mode: Lockdown, whenLoaded: Promise<unknown>): void {
	preventFunctionConstructor();
	const lockDown = mode === 'seal' || mode === 'seal-after-load' ? sealIntrinsics : freezeIntrinsics;
	if (mode === 'freeze-after-load' || mode === 'seal-after-load') whenLoaded.then(lockDown);
	else lockDown();
}

function preventFunctionConstructor() {
	Function.prototype.constructor = function () {}; // prevent this from being used to eval data in a parent context
}

/**
 * Sealing blocks the property additions prototype-pollution gadgets rely on, while existing properties stay
 * writable: instances can shadow inherited methods without accessors, and V8 keeps its fast path for stores into
 * array holes, which a read-only prototype elements kind disables process-wide.
 */
function sealIntrinsics() {
	for (const intrinsic of LOCKED_INTRINSICS) {
		Object.seal(intrinsic);
		Object.seal((intrinsic as any).prototype);
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
	for (const intrinsic of LOCKED_INTRINSICS) {
		Object.freeze(intrinsic);
		Object.freeze((intrinsic as any).prototype);
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
