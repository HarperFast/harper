import { ClientError } from '../utility/errors/hdbError.ts';
import * as crdtOperations from './crdt.ts';
import { Blob } from './blob.ts';
import * as harperLogger from '../utility/logging/harper_logger.ts';
import { isDeepStrictEqual } from 'node:util';

export const ASSERT_TRACKED_WRITABLE = Symbol('assert-tracked-writable');
export const GET_TRACKED_WRITE_GENERATION = Symbol('get-tracked-write-generation');

function assertWritable(target, generation?) {
	target[ASSERT_TRACKED_WRITABLE]?.(generation);
}

function getChanges(target) {
	assertWritable(target);
	let changes = target.getChanges();
	if (!changes) {
		changes = Object.create(null);
		target._setChanges(changes);
	}
	return changes;
}
/**
 *	A tracked class cacheable, (potentially) frozen read-only record, designed to facilitate record updates,
 *	and tracks property (and sub-object/array) changes so that on commit, any property changes can be written as part of
 *	the commit. This will also track specific updates so can record information in CRDTs.
 */
/**
 * assignObjectAccessors add methods to the prototype of the provided Target class to make
 * it a tracked object.
 * @param Target Class to add accessors to
 * @param typeDef Type definition for determining property
 */
export function assignTrackedAccessors(Target, typeDef, useFullPropertyProxy = false) {
	const prototype = Target.prototype;
	const descriptors = {};
	// Read the Array form. `typeDef.properties` is now a Record<string, JsonSchemaFragment>
	// after the schema-metadata alignment; iterating it with for...of would throw.
	// For typeDefs that only carry the Record (e.g. a programmatic Resource that declared
	// `static properties` without populating `attributes`), synthesize a minimal Array by
	// projecting the Record keys so the tracked accessors still bind something.
	const attributes =
		typeDef.attributes ||
		(typeDef.properties
			? Object.entries(typeDef.properties).map(([name, frag]) => ({ name, ...(frag as object) }))
			: []);
	for (const attribute of attributes) {
		const name = attribute.name;
		let set;
		let descriptor;
		if (attribute.resolve) {
			descriptor = {
				get() {
					return attribute.resolve(this, this.getContext?.());
				},
				set(related) {
					// Unlike the struct-prototype accessor (which tolerates a stored collision so a record can
					// still load), this is a user assignment to a resolved attribute, and a read-only resolver
					// (a scalar @computed has no attribute.set) has nowhere to put it (harper#2359).
					if (!attribute.set) throw new ClientError(`${name} is a computed attribute and can not be assigned`);
					assertWritable(this);
					return attribute.set(this, related);
				},
				configurable: true,
			};
		} else {
			switch (attribute.type) {
				case 'String':
					set = function (value) {
						if (!(typeof value === 'string' || (value == null && attribute.nullable !== false)))
							throw new ClientError(`${name} must be a string, attempt to assign ${value}`);
						getChanges(this)[name] = value;
					};
					break;
				case 'ID':
					set = function (value) {
						if (!(
							typeof value === 'string' ||
							(value?.length > 0 && value.every?.((value) => typeof value === 'string')) ||
							(value == null && attribute.nullable !== false)
						))
							throw new ClientError(`${name} must be a string, attempt to assign ${value}`);
						getChanges(this)[name] = value;
					};
					break;
				case 'Float':
				case 'Number':
					set = function (value) {
						const scalarValue = value?.__op__ ? value.value : value;
						if (!(typeof scalarValue === 'number' || (value == null && attribute.nullable !== false)))
							throw new ClientError(`${name} must be a number, attempt to assign ${scalarValue}`);
						getChanges(this)[name] = value;
					};
					break;
				case 'Int':
					set = function (value) {
						let scalarValue = value?.__op__ ? value.value : value;
						if (!(scalarValue >> 0 === scalarValue || (value == null && attribute.nullable !== false))) {
							if (typeof scalarValue === 'number' && Math.abs((scalarValue >> 0) - scalarValue) <= 1) {
								// if it just needs to be rounded, do the conversion without complaining
								scalarValue = Math.round(scalarValue);
								if (value?.__op__) value.value = scalarValue;
								else value = scalarValue;
							} else
								throw new ClientError(
									`${name} must be an integer between -2147483648 and 2147483647, attempt to assign ${value}`
								);
						}
						getChanges(this)[name] = value;
					};
					break;
				case 'Long':
					set = function (value) {
						let scalarValue = value?.__op__ ? value.value : value;
						if (!(
							(Math.round(scalarValue) === value && Math.abs(scalarValue) <= 9007199254740992) ||
							(value == null && attribute.nullable !== false)
						)) {
							if (typeof scalarValue === 'number' && Math.abs(scalarValue) <= 9007199254740992) {
								// if it just needs to be rounded, do the conversion without complaining
								scalarValue = Math.round(scalarValue);
								if (value?.__op__) value.value = scalarValue;
								else value = scalarValue;
							} else
								throw new ClientError(
									`${name} must be an integer between -9007199254740992 and 9007199254740992, attempt to assign ${value}`
								);
						}
						getChanges(this)[name] = value;
					};
					break;
				case 'BigInt':
					set = function (value) {
						let scalarValue = value?.__op__ ? value.value : value;
						if (!(typeof scalarValue === 'bigint' || (value == null && attribute.nullable !== false))) {
							if (typeof scalarValue === 'string' || typeof scalarValue === 'number') {
								scalarValue = BigInt(scalarValue);
								if (value?.__op__) value.value = scalarValue;
								else value = scalarValue;
							} else throw new ClientError(`${name} must be a number, attempt to assign ${value}`);
						}
						getChanges(this)[name] = value;
					};
					break;
				case 'Boolean':
					set = function (value) {
						if (!(typeof value === 'boolean' || (value == null && attribute.nullable !== false)))
							throw new ClientError(`${name} must be a boolean, attempt to assign ${value}`);
						getChanges(this)[name] = value;
					};
					break;
				case 'Date':
					set = function (value) {
						if (!(value instanceof Date || (value == null && attribute.nullable !== false))) {
							if (typeof value === 'string' || typeof value === 'number') value = new Date(value);
							else throw new ClientError(`${name} must be a Date, attempt to assign ${value}`);
						}
						getChanges(this)[name] = value;
					};
					break;
				case 'Bytes':
					set = function (value) {
						if (!(value instanceof Uint8Array || (value == null && attribute.nullable !== false)))
							throw new ClientError(`${name} must be a Buffer or Uint8Array, attempt to assign ${value}`);
						getChanges(this)[name] = value;
					};
					break;
				case 'Blob':
					set = function (value) {
						if (!(value instanceof Blob || (value == null && attribute.nullable !== false)))
							throw new ClientError(`${name} must be a Blob, attempt to assign ${value}`);
						getChanges(this)[name] = value;
					};
					break;
				case 'Any':
				case undefined:
					set = function (value) {
						getChanges(this)[name] = value;
					};
					break;
				default: // for all user defined types, they must at least be an object
					set = function (value) {
						if (!(typeof value === 'object' || (value == null && attribute.nullable !== false)))
							throw new ClientError(`${name} must be an object, attempt to assign ${value}`);
						getChanges(this)[name] = value;
					};
			}
			descriptor = {
				get() {
					let changes = this.getChanges?.();
					if (changes && name in changes) {
						const value = changes[name];
						if (value?.__op__) {
							const sourceValue = this.getRecord()?.[name];
							return value.update(sourceValue);
						}
						return value;
					}
					const sourceValue = this.getRecord()?.[name];
					if (sourceValue && typeof sourceValue === 'object') {
						const updatedValue = trackObject(sourceValue, attribute, this);
						// a Date, Bytes or Blob comes back untracked; caching it would make the read a change
						if (updatedValue !== sourceValue) {
							if (!changes) {
								this._setChanges((changes = Object.create(null)));
							}
							return (changes[name] = updatedValue);
						}
						return readCopy(this, name, sourceValue);
					}
					return sourceValue;
				},
				set,
				enumerable: true,
				configurable: true, // we need to be able to reconfigure these as schemas change (attributes can be added/removed at runtime)
			};
		}
		(descriptor.get as any).isAttribute = true;
		descriptors[name] = descriptor;
		if (
			!(name in prototype) ||
			// this means that we are re-defining an attribute accessor (which is fine)
			(Object.getOwnPropertyDescriptor(prototype, name)?.get as any)?.isAttribute
		) {
			Object.defineProperty(prototype, name, descriptor);
		}
	}
	setMethod('getProperty', function (name) {
		const descriptor = descriptors[name];
		if (descriptor) {
			return descriptor.get.call(this);
		}
		const changes = this.getChanges();
		if (changes?.[name] !== undefined) return changes[name];
		const value = this.getRecord()?.[name];
		return value && typeof value === 'object' ? readCopy(this, name, value) : value;
	});
	setMethod('set', function (name, value) {
		const descriptor = descriptors[name];
		if (descriptor) return descriptor.set.call(this, value);
		if (typeDef.sealed) throw new ClientError('Can not add a property to a sealed table schema');
		getChanges(this)[name] = value;
	});
	setMethod('deleteProperty', function (name) {
		getChanges(this)[name] = undefined;
	});
	setMethod('toJSON', function () {
		const changes = this.getChanges?.();
		let copiedSource;
		for (const key in changes) {
			// copy the source first so we have properties in the right order and can override them
			if (!copiedSource) copiedSource = { ...this.getRecord() };
			let value = changes[key];
			if (value?.__op__) {
				const sourceValue = copiedSource[key];
				value = value.update(sourceValue);
			}
			copiedSource[key] = value; // let recursive calls to toJSON handle sub-objects
		}
		const keys = Object.keys(this); // we use Object.keys because it is expected that the many inherited enumerables would slow a for-in loop down
		if (keys.length > 0) {
			if (!copiedSource) copiedSource = { ...this.getRecord() };
			Object.assign(copiedSource, this);
		}
		return copiedSource || this.getRecord();
	});
	if (!prototype.get) setMethod('get', prototype.getProperty);
	if (!prototype.delete) setMethod('delete', prototype.deleteProperty);
	if (!prototype.then) setMethod('then', null); // this is a shortcut to avoid the proxy for then, which is called frequently to determine if an object is a promise
	function setMethod(name, method) {
		Object.defineProperty(prototype, name, {
			value: method,
			configurable: true,
		});
	}
	// walk the prototype chain and set the prototype of the last object to the proxy that forwards to get
	let lastPrototype = prototype;
	do {
		const nextPrototype = Object.getPrototypeOf(lastPrototype);
		if (nextPrototype === Object.prototype) {
			Object.setPrototypeOf(lastPrototype, useFullPropertyProxy ? fullPropertyProxy : getOnMissingProperty);
			break;
		}
		lastPrototype = nextPrototype;
	} while (lastPrototype && lastPrototype !== getOnMissingProperty && lastPrototype !== fullPropertyProxy);
}
const ObjectPrototype = Object.prototype;
// Here we define a proxy that will handle any missing property access as a getter, that will attempt
// get the property value from the tracked object's changes or record. This is set as a prototype of
// any tracked objects (including Table/Resource instances), so that any property access will be
// intercepted by the proxy and the value will be returned from the changes or record.
const getOnMissingProperty = new Proxy({}, { get: getProxiedProperty });
const fullPropertyProxy = new Proxy({}, { get: getProxiedProperty, set: setProxiedProperty });
function getProxiedProperty(target, name, receiver) {
	if (typeof name === 'string') {
		if (name === 'then' || name === 'getRecord' || name === 'getChanges') return undefined; // shortcut
		if (ObjectPrototype[name]) return ObjectPrototype[name];
		let changes = receiver.getChanges?.();
		if (changes && name in changes) {
			return changes[name];
		}
		const sourceValue = receiver.getRecord?.()?.[name];
		if (sourceValue && typeof sourceValue === 'object') {
			const updatedValue = trackObject(sourceValue, undefined, receiver);
			if (updatedValue !== sourceValue) {
				if (!changes) {
					changes = Object.create(null);
					receiver._setChanges(changes);
				}
				changes[name] = updatedValue;
				return updatedValue;
			}
			return readCopy(receiver, name, sourceValue);
		}
		return sourceValue;
	}
}
function setProxiedProperty(target: any, name: string | symbol, value, receiver) {
	if (typeof name === 'string') {
		assertWritable(receiver);
		let changes = receiver.getChanges?.();
		if (!changes) {
			changes = {};
			receiver._setChanges(changes);
		}
		changes[name] = value;
	} else {
		Object.defineProperty(receiver, name, { value, configurable: true, writable: true });
	}
	return true;
}

const readCopies = new WeakMap<object, Map<string, { source: any; copy: any }>>();
/**
 * A Date or Bytes value read from the record, as a copy: these mutate in place but are not tracked, so
 * an edit must not reach the stored record (the commit base) without being in the patch. The copy is
 * kept per instance and property while the record value is the same, so repeated reads return the
 * same object. Reassigning the value saves it.
 */
function readCopy(owner: any, name: string, sourceValue: any) {
	let copy;
	const isDate = sourceValue instanceof Date;
	if (!isDate && !(sourceValue instanceof Uint8Array)) return sourceValue;
	let copies = readCopies.get(owner);
	const cached = copies?.get(name);
	if (cached?.source === sourceValue) return cached.copy;
	if (isDate) copy = new Date(sourceValue.getTime());
	else copy = Uint8Array.prototype.slice.call(sourceValue);
	if (!copies) readCopies.set(owner, (copies = new Map()));
	copies.set(name, { source: sourceValue, copy });
	return copy;
}
function trackObject(sourceObject: any, typeDef?: any, writableOwner?: any) {
	// lazily instantiate in case of recursive structures
	let TrackedObject;
	switch (sourceObject.constructor) {
		case Object:
			if (typeDef) {
				TrackedObject = typeDef.TrackedObject;
				if (!TrackedObject) {
					typeDef.TrackedObject = TrackedObject = class extends GenericTrackedObject {};
					assignTrackedAccessors(TrackedObject, typeDef);
				}
				return new TrackedObject(sourceObject, writableOwner);
			} else {
				return new GenericTrackedObject(sourceObject, writableOwner);
			}
		case Array:
			const trackedArray = new TrackedArray(sourceObject.length, sourceObject, writableOwner);
			for (let i = 0, l = sourceObject.length; i < l; i++) {
				let element = sourceObject[i];
				if (element && typeof element === 'object') {
					element = trackObject(element, typeDef?.elements, trackedArray);
					// an element's in-place edit must reach the patch (hasChanges compares these by value), not the record
					if (element instanceof Date) element = new Date(element.getTime());
					else if (element instanceof Uint8Array) element = Uint8Array.prototype.slice.call(element);
				}
				trackedArray[i] = element;
			}
			if (!writableOwner) return trackedArray;
			return new Proxy(trackedArray, {
				set(target, name, value) {
					if (typeof name === 'string') {
						assertWritable(target);
						target[HAS_ARRAY_CHANGES] = true;
					}
					return Reflect.set(target, name, value, target);
				},
				defineProperty(target, name, descriptor) {
					if (typeof name === 'string') {
						assertWritable(target);
						target[HAS_ARRAY_CHANGES] = true;
					}
					return Reflect.defineProperty(target, name, descriptor);
				},
				deleteProperty(target, name) {
					if (typeof name === 'string') {
						assertWritable(target);
						target[HAS_ARRAY_CHANGES] = true;
					}
					return Reflect.deleteProperty(target, name);
				},
			});
		// any other objects (like Date) are left unchanged
		default:
			return sourceObject;
	}
}
export class GenericTrackedObject<T extends object = any> {
	#record: T;
	#changes: Partial<T>;
	#writableOwner: any;
	#writableGeneration: any;
	constructor(sourceObject?: GenericTrackedObject<T> | T, writableOwner?: any) {
		if (isTracked(sourceObject))
			throw new Error('Can not track an already tracked object, check for circular references');
		this.#record = sourceObject as any;
		this.#writableOwner = writableOwner;
		this.#writableGeneration = writableOwner?.[GET_TRACKED_WRITE_GENERATION]?.();
	}
	[ASSERT_TRACKED_WRITABLE]() {
		this.#writableOwner?.[ASSERT_TRACKED_WRITABLE]?.(this.#writableGeneration);
	}
	[GET_TRACKED_WRITE_GENERATION]() {
		return this.#writableGeneration;
	}
	getRecord(): T {
		return this.#record;
	}
	setRecord(record: T) {
		this.#record = record;
	}
	getChanges() {
		return this.#changes;
	}
	_setChanges(changes: Partial<T>) {
		this.#changes = changes;
	}
}
assignTrackedAccessors(GenericTrackedObject, {}, true);
/**
 * Collapse the changed and transitive and source/record data into single object that
 * can be directly serialized. Performed recursively
 * @param target
 * @returns
 */
export function collapseData(target) {
	if (target.constructor === Array) return collapseArray(target);
	const changes = target.getChanges?.();
	let copiedSource;
	for (const key in changes) {
		// copy the source first so we have properties in the right order and can override them
		if (!copiedSource) copiedSource = isTracked(target) ? { ...target.getRecord() } : {};
		let value = changes[key];
		if (value && typeof value === 'object') {
			if (value.__op__) {
				const sourceValue = copiedSource[key];
				value = value.update(sourceValue);
			} else value = collapseData(value);
		}
		copiedSource[key] = value;
	}
	const keys = Object.keys(target); // we use Object.keys because it is expected that the many inherited enumerables would slow a for-in loop down
	if (keys.length > 0) {
		if (!copiedSource) copiedSource = isTracked(target) ? { ...target.getRecord() } : {};
		Object.assign(copiedSource, target);
	}
	return copiedSource || (isTracked(target) ? target.getRecord() : undefined) || target;
}
function collapseArray(target: any) {
	if (isTracked(target) && !hasChanges(target)) return target.getRecord();
	return materializeArray(target);
}
function materializeArray(target) {
	const collapsed = new Array(target.length);
	for (let i = 0, l = target.length; i < l; i++) {
		const element = target[i];
		collapsed[i] = isTracked(element) ? collapseData(element) : element;
	}
	return collapsed;
}
const hasOwnProperty = Object.prototype.hasOwnProperty;
// a data member named getRecord (JSON can carry one) does not make a value a tracked wrapper
function isTracked(value) {
	return typeof value?.getRecord === 'function';
}
/**
 * Collapse the changed data and source/record data into single object
 * that is frozen and suitable for storage and caching
 * @param target
 * @returns
 */
export function updateAndFreeze(target, changes = target.getChanges?.(), mergeOwnProperties = true) {
	let mergedUpdatedObject: any;
	if (!target) return changes;
	if (isTracked(target) && target.constructor === Array && !Object.isFrozen(target)) {
		if (!hasChanges(target)) return (target as any).getRecord();
		// Materialize a plain array so the stored value retains neither the mutation proxy nor its owner.
		mergedUpdatedObject = new Array(target.length);
		for (let i = 0, l = target.length; i < l; i++) {
			let value = target[i];
			if (value && typeof value === 'object') {
				value = updateAndFreeze(value);
			}
			mergedUpdatedObject[i] = value;
		}
		return Object.freeze(mergedUpdatedObject);
	}
	// copy the changes into the merged updated object
	for (const key in changes) {
		// copy the source first so we have properties in the right order and can override them
		if (!mergedUpdatedObject) mergedUpdatedObject = { ...(isTracked(target) ? target.getRecord() : target) };
		let value = changes[key];
		if (value && typeof value === 'object') {
			if (value.__op__) {
				// Resolve against the explicit operation registry, not the crdt.ts export namespace,
				// so a crafted/corrupt `__op__` naming another export can't be invoked as an operation.
				const operation = crdtOperations.operations[value.__op__];
				if (operation) operation(mergedUpdatedObject, key, value);
				else {
					// An unrecognized CRDT operation — corruption, or an op type from a newer node this
					// version can't apply. This runs on the write/replication apply path, where throwing
					// would abort the commit and can wedge a subscription, so skip the op instead: the
					// field keeps its base value and a full-copy re-converges the record. Read-path
					// reconstruction (crdt.applyForward/applyReverse) still throws loudly by design.
					harperLogger.warn(`Skipping unrecognized CRDT operation "${value.__op__}" on property "${key}"`);
				}
				continue;
			} else value = updateAndFreeze(value);
		}
		mergedUpdatedObject[key] = value;
	}
	// now copy any properties on the instances itself to the merged updated object
	if (mergeOwnProperties && !Array.isArray(target) && isTracked(target)) {
		for (const key in target) {
			if (hasOwnProperty.call(target, key)) {
				if (!mergedUpdatedObject) mergedUpdatedObject = { ...target.getRecord() };
				mergedUpdatedObject[key] = target[key];
			}
		}
	}
	return mergedUpdatedObject ? Object.freeze(mergedUpdatedObject) : isTracked(target) ? target.getRecord() : target;
}
/**
 * Determine if any changes have been made to this tracked object
 * @param target
 * @returns
 */
export function hasChanges(target) {
	const source = target.getRecord?.();
	if (source === undefined) return true; // if no original source then it is always a change
	if (target.constructor === Array) {
		if (!source) return true;
		if (target[HAS_ARRAY_CHANGES]) return true;
		if (target.length !== source.length) return true;
		for (let i = 0, l = target.length; i < l; i++) {
			const sourceValue = source[i];
			const targetValue = target[i];
			if (sameValue(targetValue, sourceValue) || sameCopy(targetValue, sourceValue)) continue;
			if (sourceValue && isTracked(targetValue) && targetValue.getRecord() === sourceValue) {
				if (hasChanges(targetValue)) return true;
			} else return true;
		}
	} else {
		const changes = target.getChanges?.();
		if (changes && !source) return true;
		for (const key in changes) {
			if (hasOwnChange(target, key)) continue;
			const value = changes[key];
			if (value && typeof value === 'object') {
				const sourceValue = source[key];
				// could just be a copy, need to check
				if (sourceValue && isTracked(value) && value.getRecord() === sourceValue) {
					if (hasChanges(value)) return true;
				} else return true;
			} else return true;
		}
		for (const key of Object.keys(target)) {
			const value = target[key];
			if (!sameOwnValue(value, source?.[key]) && !atOwnBaseline(target, key, value)) return true;
		}
	}
	return false;
}
const ownBaselines = new WeakMap<object, any>();
const SNAPSHOT = Symbol('snapshot');
const IDENTITY = Symbol('identity');
/**
 * Record the own properties a framework-constructed instance starts with (class fields such as `hits = 0`
 * on a Table subclass), so they enter a patch only once changed. An object `structuredClone` reproduces (plain
 * data, a Date) can change in place, so it is kept as a deep copy and compared by content; any other value
 * (a helper instance, a Buffer, a function) is compared by identity.
 */
export function recordOwnBaseline(instance: any) {
	let baseline;
	for (const key of Object.keys(instance)) {
		let value = instance[key];
		if (typeof value === 'function') value = { [IDENTITY]: value };
		else if (value !== null && typeof value === 'object') {
			const copy = contentCopy(value);
			value = copy === undefined ? { [IDENTITY]: value } : { [SNAPSHOT]: copy };
		}
		(baseline ??= Object.create(null))[key] = value;
	}
	if (baseline) ownBaselines.set(instance, baseline);
}
function atOwnBaseline(target, key: string, value) {
	const baseline = ownBaselines.get(target);
	if (baseline === undefined || !(key in baseline)) return false;
	const initial = baseline[key];
	if (initial?.[SNAPSHOT]) return isDeepStrictEqual(value, initial[SNAPSHOT]);
	if (initial?.[IDENTITY]) return value === initial[IDENTITY];
	return sameValue(value, initial);
}
/** After a commit, an own property it wrote is compared with the record, not with its initial value */
export function releaseOwnBaseline(target, patch) {
	const baseline = ownBaselines.get(target);
	if (baseline === undefined) return;
	for (const key in patch) {
		if (key in baseline && hasOwnProperty.call(target, key) && !atOwnBaseline(target, key, target[key]))
			delete baseline[key];
	}
}
/** Whether an own property of the instance is data to write, rather than an untouched class field */
export function hasOwnChange(target, key: string) {
	return hasOwnProperty.call(target, key) && !atOwnBaseline(target, key, target[key]);
}
// An own object value is not tracked: the record gets a copy, so a later in-place edit of the instance's
// object is a difference in content rather than invisible. A value that does not copy to the same content
// (one holding a Blob) is stored as it is.
function plainCopy(value) {
	if (value === null || typeof value !== 'object') return value;
	if (value instanceof Date) return new Date(value.getTime());
	if (value instanceof Uint8Array) return Uint8Array.prototype.slice.call(value);
	if (!isPlainData(value)) return value;
	return contentCopy(value) ?? value;
}
// by prototype, since `constructor` can be a data member
function isPlainData(value) {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === Array.prototype || prototype === null;
}
function contentCopy(value) {
	let copy;
	try {
		copy = structuredClone(value);
	} catch {
		return;
	}
	if (Object.getPrototypeOf(value) === null) Object.setPrototypeOf(copy, null);
	return isDeepStrictEqual(copy, value) ? copy : undefined;
}
function sameOwnValue(value, recordValue) {
	if (sameValue(value, recordValue) || sameCopy(value, recordValue)) return true;
	return value !== null && typeof value === 'object' && isPlainData(value) && isDeepStrictEqual(value, recordValue);
}
function sameValue(a, b) {
	return a === b || (a !== a && b !== b); // NaN
}
function sameCopy(copy, source) {
	if (copy instanceof Date) return source instanceof Date && sameValue(copy.getTime(), source.getTime());
	if (copy instanceof Uint8Array) return source instanceof Uint8Array && Buffer.compare(copy, source) === 0;
	return false;
}

/**
 * The incremental update a tracked instance commits (see resources/DESIGN.md). Returns undefined when
 * nothing changed on an existing record, and `changes` itself when it needs no normalization; never
 * mutates `changes`, which is the instance's live tracked state or the caller's update object.
 */
export function collapseChanges(target, changes) {
	// a non-object root (an array, binary data) is not a patch; leave it for the write's root validation
	if (changes != null && (typeof changes !== 'object' || Array.isArray(changes) || ArrayBuffer.isView(changes)))
		return changes;
	const source = target.getRecord?.();
	const ownKeys = Object.keys(target);
	let patch = changes;
	let keyCount = 0;
	for (const key in changes) {
		const value = changes[key];
		let committed = value;
		if (ownKeys.length > 0 && hasOwnChange(target, key)) committed = OMITTED;
		else if (isTracked(value)) {
			if (source && value.getRecord() === source[key] && !hasChanges(value)) committed = OMITTED;
			else committed = value.constructor === Array ? materializeArray(value) : collapseData(value);
		}
		if (committed !== value && patch === changes) {
			patch = Object.create(null);
			for (const priorKey in changes) {
				if (priorKey === key) break;
				patch[priorKey] = changes[priorKey];
			}
		}
		if (committed === OMITTED) continue;
		if (patch !== changes) patch[key] = committed;
		keyCount++;
	}
	for (const key of ownKeys) {
		const value = target[key];
		if (sameOwnValue(value, source?.[key]) || atOwnBaseline(target, key, value)) continue;
		if (patch === changes) patch = Object.assign(Object.create(null), changes);
		patch[key] = isTracked(value) ? collapseData(value) : plainCopy(value);
		keyCount++;
	}
	// with no record to compare against, any update (even an empty one) writes, as hasChanges decides
	if (keyCount === 0) return source ? undefined : patch;
	return patch;
}
const OMITTED = {};

/**
 * Add a numeric delta to a property of a tracked object, composing with whatever this transaction
 * already set for it: a pending addition folds into a single addition, an assigned value becomes the
 * sum.
 */
export function addToChanges(target, property: string, value: number | bigint) {
	if (hasOwnChange(target, property)) {
		target[property] = crdtOperations.addValues(target[property], value);
		return;
	}
	const changes = target.getChanges();
	if (changes && Object.hasOwn(changes, property)) {
		const prior = changes[property];
		// a tracked wrapper that was only read is not a prior value
		if (isTracked(prior) && prior.getRecord() === target.getRecord?.()?.[property] && !hasChanges(prior))
			target.set(property, new Addition(value));
		else if (prior?.__op__ === 'add')
			target.set(property, new Addition(addDeltas(prior.value, value, target.getRecord?.()?.[property])));
		else target.set(property, crdtOperations.addValues(prior, value));
	} else target.set(property, new Addition(value));
}

// Sum two deltas in the stored value's numeric type, so folding them gives what applying them in turn
// would (a bigint field keeps full precision; a number field accepts a bigint then a fractional delta)
function addDeltas(first, second, stored) {
	if (typeof stored === 'bigint') return BigInt(first) + BigInt(second);
	if (stored == null || isNaN(+stored)) return crdtOperations.addValues(first, second);
	return Number(first) + Number(second);
}

const HAS_ARRAY_CHANGES = Symbol.for('has-array-changes');
const TRACKED_ARRAY_RECORD = Symbol('tracked-array-record');
const TRACKED_WRITABLE_OWNER = Symbol('tracked-writable-owner');
const TRACKED_WRITABLE_GENERATION = Symbol('tracked-writable-generation');
class TrackedArray extends Array {
	[TRACKED_ARRAY_RECORD]: any;
	[TRACKED_WRITABLE_OWNER]: any;
	[TRACKED_WRITABLE_GENERATION]: any;
	[HAS_ARRAY_CHANGES]: boolean;
	constructor(length, record, writableOwner) {
		super(length);
		this[TRACKED_ARRAY_RECORD] = record;
		this[TRACKED_WRITABLE_OWNER] = writableOwner;
		this[TRACKED_WRITABLE_GENERATION] = writableOwner?.[GET_TRACKED_WRITE_GENERATION]?.();
	}
	[ASSERT_TRACKED_WRITABLE]() {
		this[TRACKED_WRITABLE_OWNER]?.[ASSERT_TRACKED_WRITABLE]?.(this[TRACKED_WRITABLE_GENERATION]);
	}
	[GET_TRACKED_WRITE_GENERATION]() {
		return this[TRACKED_WRITABLE_GENERATION];
	}
	getRecord() {
		return this[TRACKED_ARRAY_RECORD];
	}
	splice(...args) {
		this[HAS_ARRAY_CHANGES] = true;
		return (super.splice as any)(...args);
	}
	push(...args) {
		this[HAS_ARRAY_CHANGES] = true;
		return (super.push as any)(...args);
	}
	pop() {
		this[HAS_ARRAY_CHANGES] = true;
		return super.pop();
	}
	unshift(...args) {
		this[HAS_ARRAY_CHANGES] = true;
		return (super.unshift as any)(...args);
	}
	shift() {
		this[HAS_ARRAY_CHANGES] = true;
		return super.shift();
	}
}
TrackedArray.prototype.constructor = Array; // this makes type checks easier/faster (and we want it to be Array like too)

// Copy a record into a resource, using copy-on-write for nested objects/arrays
export function copyRecord(record, targetResource, attributes = Object.keys(record)) {
	targetResource.setRecord(record);
	for (const attribute of attributes) {
		// do not override existing methods
		if (targetResource[attribute] === undefined) {
			const value = record[attribute];
			// use copy-on-write for sub-objects
			if (typeof value === 'object' && value) setSubObject(targetResource, attribute, value);
			// primitives can be directly copied
			else targetResource[attribute] = value;
		}
	}
}
export const NOT_COPIED_YET = {};
let copyEnabled = true;
function setSubObject(targetResource, key, storedValue) {
	let value = NOT_COPIED_YET;
	Object.defineProperty(targetResource, key, {
		get() {
			if (value === NOT_COPIED_YET && copyEnabled) {
				switch (storedValue.constructor) {
					case Object:
						copyRecord(storedValue, (value = new UpdatableObject()));
						break;
					case Array:
						copyArray(storedValue, (value = new UpdatableArray()));
						break;
					default:
						value = storedValue;
				}
			}
			return value;
		},
		set(newValue) {
			value = newValue;
		},
		enumerable: true,
		configurable: true,
	});
}
export function withoutCopying(callback) {
	copyEnabled = false;
	const result = callback();
	copyEnabled = true;
	return result;
}
class UpdatableObject {
	// eventually provide CRDT functions here like add, subtract
}
class UpdatableArray extends Array {
	// eventually provide CRDT tracking for push, unshift, pop, etc.
}
function copyArray(storedArray, targetArray) {
	for (let i = 0, l = storedArray.length; i < l; i++) {
		let value = storedArray[i];
		// copy sub-objects (it assumed we don't really need to lazily access entries in an array,
		// if an array is accessed, probably all elements in array will be accessed
		if (typeof value === 'object' && value) {
			if (value.constructor === Object) copyRecord(value, (value = new UpdatableObject()));
			else if (value.constructor === Array) copyArray(value, (value = new UpdatableArray()));
		}
		targetArray[i] = value;
	}
}
export class Addition {
	__op__ = 'add';
	value: any;
	constructor(value) {
		this.value = value;
	}
	update(previousValue) {
		// Shared with crdt.add so the read path folds identically to the storage path.
		return crdtOperations.addValues(previousValue, this.value);
	}
}
