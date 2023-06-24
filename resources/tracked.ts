import { RECORD_PROPERTY } from './Resource';
import { ClientError } from '../utility/errors/hdbError';
// perhaps we want these in the global registry, not sure:
export const OWN_DATA = Symbol('own-data'); // property that references an object with any changed properties or cloned/writable sub-objects
const record_class_cache = {}; // we cache the WritableRecord classes because they are pretty expensive to create

function getChanges(target) {
	return target[OWN_DATA] || (target[OWN_DATA] = Object.create(null));
}
/**
 *	A TrackedObject is a wrapper around a cacheable, frozen read-only record, designed to facilitate record updates,
 *	and tracks property (and sub-object/array) changes so that on commit, any property changes can be written as part of
 *	the commit. This will also track specific updates so can record information in CRDTs.
 */

export function assignObjectAccessors(Target, type_def) {
	const prototype = Target.prototype;
	const descriptors = {};
	const attributes = type_def.attributes || type_def.properties || [];
	for (const attribute of attributes) {
		const name = attribute.name;
		let TrackedObject, TrackedArray;
		const descriptor = {
			get() {
				let changes = this[OWN_DATA];
				if (changes && name in changes) {
					return changes[name];
				}
				const source_value = this[RECORD_PROPERTY]?.[name];
				if (source_value && typeof source_value === 'object') {
					// lazily instantiate in case of recursive structures
					switch (source_value.constructor) {
						case Object:
							if (!TrackedObject) {
								TrackedObject = class {
									constructor(source) {
										this[RECORD_PROPERTY] = source;
									}
								};
								assignObjectAccessors(TrackedObject, attribute);
							}
							if (!changes) changes = this[OWN_DATA] = Object.create(null);
							return (changes[name] = new TrackedObject(source_value));
						case Array:
							if (!TrackedArray) {
								TrackedArray = class extends BaseTrackedArray {
									static attribute = attribute.elements;
								};
							}
							if (!changes) changes = this[OWN_DATA] = Object.create(null);
							return (changes[name] = new TrackedArray(source_value));
						// any other objects (like Date) just returned below
					}
				}
				return source_value;
			},
			set(value) {
				getChanges(this)[name] = value;
			},
			enumerable: true,
			configurable: true, // we need to be able to reconfigure these as schemas change (attributes can be added/removed at runtime)
		};
		descriptor.get.isAttribute = true;
		switch (attribute.type) {
			case 'String':
				descriptor.set = function (value) {
					if (typeof value !== 'string') throw ClientError(`${name} must be a string, attempt to assign ${value}`);
					getChanges(this)[name] = value;
				};
				break;
			case 'Int':
				descriptor.set = function (value) {
					if (typeof value !== 'number') throw ClientError(`${name} must be a string, attempt to assign ${value}`);
					getChanges(this)[name] = value;
				};
				break;
		}

		descriptors[name] = descriptor;
		if (
			!(name in prototype) ||
			// this means that we are re-defining an attribute accessor (which is fine)
			Object.getOwnPropertyDescriptor(prototype, name).get?.isAttribute
		) {
			Object.defineProperty(prototype, name, descriptor);
		}
	}
	prototype.getProperty = function (name) {
		const descriptor = descriptors[name];
		if (descriptor) return descriptor.set.call(this, value);
		const changes = this[OWN_DATA];
		if (changes?.[name] !== undefined) return changes[name];
		return this[RECORD_PROPERTY]?.[name];
	};
	prototype.set = function (name, value) {
		const descriptor = descriptors[name];
		if (descriptor) return descriptor.set.call(this, value);
		if (type_def.sealed) throw new ClientError('Can not add a property to a sealed table schema');
		getChanges(this)[name] = value;
	};
	prototype.deleteProperty = function (name) {
		getChanges(this)[name] = undefined;
	};
	if (!prototype.get) prototype.get = prototype.getProperty;
	if (!prototype.delete) prototype.delete = prototype.deleteProperty;
}
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
	const changes = target[OWN_DATA];
	let copied_source;
	for (const key in changes) {
		// copy the source first so we have properties in the right order and can override them
		if (!copied_source) copied_source = Object.assign({}, target[RECORD_PROPERTY]);
		let value = changes[key];
		if (value && typeof value === 'object') {
			value = deepFreeze(value);
		}
		copied_source[key] = value;
	}
	return copied_source ? Object.freeze(copied_source) : target[RECORD_PROPERTY] || Object.freeze(target);
}
export function hasChanges(target) {
	if (!target[RECORD_PROPERTY]) return true; // if no original source then it is always a change
	const changes = target[OWN_DATA];
	for (const key in changes) {
		const value = changes[key];
		if (value && typeof value === 'object') {
			const source_value = target[RECORD_PROPERTY][key];
			// could just be a copy, need to check
			if (source_value && value[RECORD_PROPERTY] === source_value) {
				if (hasChanges(value)) return true;
			} else return true;
		} else return true;
	}
}

class BaseTrackedArray extends Array {
	constructor(source: []) {
		super();
		super.push(...source);
	}
}

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
