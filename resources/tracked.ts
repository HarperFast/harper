import { RECORD_PROPERTY } from './Resource';
import { ClientError } from '../utility/errors/hdbError';
// perhaps we want these in the global registry, not sure:
export const OWN_DATA = Symbol('own-data'); // property that references an object with any changed properties or cloned/writable sub-objects
const record_class_cache = {}; // we cache the WritableRecord classes because they are pretty expensive to create

function getChanges(target) {
	return target[OWN_DATA] || (target[OWN_DATA] = Object.create(null));
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
 * @param type_def Type definition for determining property
 */
export function assignTrackedAccessors(Target, type_def) {
	const prototype = Target.prototype;
	const descriptors = {};
	const attributes = type_def.attributes || type_def.properties || [];
	for (const attribute of attributes) {
		const name = attribute.name;
		let set;
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
					if (
						!(
							typeof value === 'string' ||
							(value?.length > 0 && value.every?.((value) => typeof value === 'string')) ||
							(value == null && attribute.nullable !== false)
						)
					)
						throw new ClientError(`${name} must be a string, attempt to assign ${value}`);
					getChanges(this)[name] = value;
				};
				break;
			case 'Float':
				set = function (value) {
					if (!(typeof value === 'number' || (value == null && attribute.nullable !== false)))
						throw new ClientError(`${name} must be a number, attempt to assign ${value}`);
					getChanges(this)[name] = value;
				};
				break;
			case 'Int':
				set = function (value) {
					if (!(value >> 0 === value || (value == null && attribute.nullable !== false))) {
						if (typeof value === 'number' && Math.abs((value >> 0) - value) <= 1) {
							// if it just needs to be rounded, do the conversion without complaining
							value = Math.round(value);
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
					if (
						!(
							(Math.round(value) === value && Math.abs(value) <= 9007199254740992) ||
							(value == null && attribute.nullable !== false)
						)
					) {
						if (typeof value === 'number' && Math.abs(value) <= 9007199254740992) {
							// if it just needs to be rounded, do the conversion without complaining
							value = Math.round(value);
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
					if (!(typeof value === 'bigint' || (value == null && attribute.nullable !== false))) {
						if (typeof value === 'string' || typeof value === 'number') value = BigInt(value);
						else throw new ClientError(`${name} must be a number, attempt to assign ${value}`);
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
		const descriptor = (descriptors[name] = {
			get() {
				let changes = this[OWN_DATA];
				if (changes && name in changes) {
					return changes[name];
				}
				const source_value = this[RECORD_PROPERTY]?.[name];
				if (source_value && typeof source_value === 'object') {
					const updated_value = trackObject(source_value, attribute);
					if (updated_value) {
						if (!changes) changes = this[OWN_DATA] = Object.create(null);
						return (changes[name] = updated_value);
					}
				}
				return source_value;
			},
			set,
			enumerable: true,
			configurable: true, // we need to be able to reconfigure these as schemas change (attributes can be added/removed at runtime)
		});
		descriptor.get.isAttribute = true;
		if (
			!(name in prototype) ||
			// this means that we are re-defining an attribute accessor (which is fine)
			Object.getOwnPropertyDescriptor(prototype, name)?.get?.isAttribute
		) {
			Object.defineProperty(prototype, name, descriptor);
		}
	}
	setMethod('getProperty', function (name) {
		const descriptor = descriptors[name];
		if (descriptor) return descriptor.get.call(this);
		const changes = this[OWN_DATA];
		if (changes?.[name] !== undefined) return changes[name];
		return this[RECORD_PROPERTY]?.[name];
	});
	setMethod('set', function (name, value) {
		const descriptor = descriptors[name];
		if (descriptor) return descriptor.set.call(this, value);
		if (type_def.sealed) throw new ClientError('Can not add a property to a sealed table schema');
		getChanges(this)[name] = value;
	});
	setMethod('deleteProperty', function (name) {
		getChanges(this)[name] = undefined;
	});
	setMethod('toJSON', function () {
		const changes = this[OWN_DATA];
		let copied_source;
		for (const key in changes) {
			// copy the source first so we have properties in the right order and can override them
			if (!copied_source) copied_source = Object.assign({}, this[RECORD_PROPERTY]);
			copied_source[key] = changes[key]; // let recursive calls to toJSON handle sub-objects
		}
		const keys = Object.keys(this); // we use Object.keys because it is expected that the many inherited enumerables would slow a for-in loop down
		if (keys.length > 0) {
			if (!copied_source) copied_source = Object.assign({}, this[RECORD_PROPERTY]);
			Object.assign(copied_source, this);
		}
		return copied_source || this[RECORD_PROPERTY];
	});
	if (!prototype.get) setMethod('get', prototype.getProperty);
	if (!prototype.delete) setMethod('delete', prototype.deleteProperty);
	function setMethod(name, method) {
		Object.defineProperty(prototype, name, {
			value: method,
			configurable: true,
		});
	}
}
function trackObject(source_object, type_def) {
	// lazily instantiate in case of recursive structures
	let TrackedObject;
	switch (source_object.constructor) {
		case Object:
			if (type_def) {
				if (!(TrackedObject = type_def.TrackedObject)) {
					type_def.TrackedObject = TrackedObject = class {
						constructor(source_object) {
							this[RECORD_PROPERTY] = source_object;
						}
					};
					assignTrackedAccessors(TrackedObject, type_def);
				}
				return new TrackedObject(source_object);
			} else {
				return new GenericTrackedObject(source_object);
			}
		case Array:
			const tracked_array = new TrackedArray(source_object.length);
			tracked_array[RECORD_PROPERTY] = source_object;
			for (let i = 0, l = source_object.length; i < l; i++) {
				let element = source_object[i];
				if (element && typeof element === 'object') element = trackObject(element, type_def?.elements);
				tracked_array[i] = element;
			}
			return tracked_array;
		// any other objects (like Date) are left unchanged
	}
}
class GenericTrackedObject {
	constructor(source_object) {
		this[RECORD_PROPERTY] = source_object;
	}
}
assignTrackedAccessors(GenericTrackedObject, {});
/**
 * Collapse the changed and transitive and source/record data into single object that
 * can be directly serialized. Performed recursively
 * @param target
 * @returns
 */
export function collapseData(target) {
	const changes = target[OWN_DATA];
	let copied_source;
	for (const key in changes) {
		// copy the source first so we have properties in the right order and can override them
		if (!copied_source) copied_source = Object.assign({}, target[RECORD_PROPERTY]);
		let value = changes[key];
		if (value && typeof value === 'object') {
			value = collapseData(value);
		}
		copied_source[key] = value;
	}
	const keys = Object.keys(target); // we use Object.keys because it is expected that the many inherited enumerables would slow a for-in loop down
	if (keys.length > 0) {
		if (!copied_source) copied_source = Object.assign({}, target[RECORD_PROPERTY]);
		Object.assign(copied_source, target);
	}
	return copied_source || target[RECORD_PROPERTY];
}
/**
 * Collapse the changed data and source/record data into single object
 * that is frozen and suitable for storage and caching
 * @param target
 * @returns
 */
export function deepFreeze(target) {
	let copied_source;
	if (target[RECORD_PROPERTY] && target.constructor === Array && !Object.isFrozen(target)) {
		// a tracked array, by default we can freeze the tracked array itself
		copied_source = target;
		for (let i = 0, l = target.length; i < l; i++) {
			let value = target[i];
			if (value && typeof value === 'object') {
				const new_value = deepFreeze(value);
				if (new_value !== value && copied_source === target) {
					// if we need to make any changes to the user's array, we make a copy so we don't modify
					// an array that the user may be using with transient properties
					copied_source = target.slice(0);
				}
				value = new_value;
			}
			copied_source[i] = value;
		}
		return Object.freeze(copied_source);
	}
	const changes = target[OWN_DATA];
	for (const key in changes) {
		// copy the source first so we have properties in the right order and can override them
		if (!copied_source) copied_source = Object.assign({}, target[RECORD_PROPERTY]);
		let value = changes[key];
		if (value && typeof value === 'object') {
			value = deepFreeze(value);
		}
		copied_source[key] = value;
	}
	return copied_source
		? Object.freeze(copied_source)
		: target[RECORD_PROPERTY] ||
				// freeze, but don't freeze buffers/typed arrays, that doesn't work
				(target.buffer ? target : Object.freeze(target));
}
/**
 * Determine if any changes have been made to this tracked object
 * @param target
 * @returns
 */
export function hasChanges(target) {
	const source = target[RECORD_PROPERTY];
	if (source === undefined) return true; // if no original source then it is always a change
	if (target.constructor === Array) {
		if (!source) return true;
		if (target[HAS_ARRAY_CHANGES]) return true;
		if (target.length !== source.length) return true;
		for (let i = 0, l = target.length; i < l; i++) {
			const source_value = source[i];
			const target_value = target[i];
			if (source_value && target_value?.[RECORD_PROPERTY] === source_value) {
				if (hasChanges(target_value)) return true;
			} else return true;
		}
	} else {
		const changes = target[OWN_DATA];
		if (changes && !source) return true;
		for (const key in changes) {
			const value = changes[key];
			if (value && typeof value === 'object') {
				const source_value = source[key];
				// could just be a copy, need to check
				if (source_value && value[RECORD_PROPERTY] === source_value) {
					if (hasChanges(value)) return true;
				} else return true;
			} else return true;
		}
	}
	return false;
}

const HAS_ARRAY_CHANGES = Symbol.for('has-array-changes');
class TrackedArray extends Array {
	[HAS_ARRAY_CHANGES]: boolean;
	constructor(length) {
		super(length);
	}
	splice(...args) {
		this[HAS_ARRAY_CHANGES] = true;
		return super.splice(...args);
	}
	push(...args) {
		this[HAS_ARRAY_CHANGES] = true;
		return super.push(...args);
	}
	pop() {
		this[HAS_ARRAY_CHANGES] = true;
		return super.pop();
	}
	unshift(...args) {
		this[HAS_ARRAY_CHANGES] = true;
		return super.unshift(...args);
	}
	shift() {
		this[HAS_ARRAY_CHANGES] = true;
		return super.shift();
	}
}
TrackedArray.prototype.constructor = Array; // this makes type checks easier/faster (and we want it to be Array like too)

// Copy a record into a resource, using copy-on-write for nested objects/arrays
export function copyRecord(record, target_resource, attributes) {
	target_resource[RECORD_PROPERTY] = record;
	for (const attribute of attributes) {
		// do not override existing methods
		if (target_resource[key] === undefined) {
			const value = record[key];
			// use copy-on-write for sub-objects
			if (typeof value === 'object' && value) setSubObject(target_resource, key, value);
			// primitives can be directly copied
			else target_resource[key] = value;
		}
	}
}
export const NOT_COPIED_YET = {};
let copy_enabled = true;
function setSubObject(target_resource, key, stored_value) {
	let value = NOT_COPIED_YET;
	Object.defineProperty(target_resource, key, {
		get() {
			if (value === NOT_COPIED_YET && copy_enabled) {
				switch (stored_value.constructor) {
					case Object:
						copyRecord(stored_value, (value = new UpdatableObject()));
						break;
					case Array:
						copyArray(stored_value, (value = new UpdatableArray()));
						break;
					default:
						value = stored_value;
				}
			}
			return value;
		},
		set(new_value) {
			value = new_value;
		},
		enumerable: true,
		configurable: true,
	});
}
export function withoutCopying(callback) {
	copy_enabled = false;
	const result = callback();
	copy_enabled = true;
	return result;
}
class UpdatableObject {
	// eventually provide CRDT functions here like add, subtract
}
class UpdatableArray extends Array {
	// eventually provide CRDT tracking for push, unshift, pop, etc.
}
function copyArray(stored_array, target_array) {
	for (let i = 0, l = stored_array.length; i < l; i++) {
		let value = stored_array[i];
		// copy sub-objects (it assumed we don't really need to lazily access entries in an array,
		// if an array is accessed, probably all elements in array will be accessed
		if (typeof value === 'object' && value) {
			if (value.constructor === Object) copyRecord(value, (value = new UpdatableObject()));
			else if (value.constructor === Array) copyArray(value, (value = new UpdatableArray()));
		}
		target_array[i] = value;
	}
}
