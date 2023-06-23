import { RECORD_PROPERTY, EXPLICIT_CHANGES_PROPERTY } from './Resource';
import { ClientError } from '../utility/errors/hdbError';
const RECORD_CLASS = Symbol('writable-record-class');
const SOURCE_SYMBOL = Symbol.for('source');
// perhaps we want these in the global registry, not sure:
export const DATA = Symbol('original-data'); // property that references the original (readonly) record for a writable record
export const OWN = Symbol('own'); // property that references an object with any changed properties or cloned/writable sub-objects
const record_class_cache = {}; // we cache the WritableRecord classes because they are pretty expensive to create

/**
 *	A WritableRecord is a wrapper around a cacheable, frozen read-only record, designed to facilitate record updates,
 *	and tracks property (and sub-object/array) changes so that on commit, any property changes can be written as part of
 *	the commit. This will also track specific updates so can record information in CRDTs.
 * @param record_data
 */
export function getWritableRecord(record_data) {
	// fast path to instantiating a WritableRecord instance for a record, that gives users the ability to make changes,
	// have those changes be tracked, and then have those changes be committed when the transaction commits
	let WritableRecord = record_data[RECORD_CLASS];
	if (!WritableRecord) {
		// TODO: if it is an array, need a tracking array class
		let has_distinct_stable_prototype = record_data[SOURCE_SYMBOL]; // if we can rely on a stable structure/shape based on the prototype
		let from = has_distinct_stable_prototype ? record_data.constructor.prototype : record_data;
		let next: any = record_class_cache;
		for (let key in from) {
			next = next[key] || (next[key] = {})
		}
		WritableRecord = next.__copy__ || (next.__copy__ = createWritableRecordClass(from));
		if (has_distinct_stable_prototype)
			from[RECORD_CLASS] = WritableRecord;
	}
	return new WritableRecord(record_data);
}

/**
 * If we didn't have a cached WritableRecord, actually create the class here (this is expensive)
 * @param from
 */
function createWritableRecordClass(from) {
	class WritableRecord {
		constructor(data) {
			this[DATA] = data;
			this[OWN] = {};
		}

		/**
		 * This flattens the object for the sake of serialization and iterating through the keys
		 */
		toJSON() {
			return Object.assign({}, this[DATA], this[OWN]);
		}
	}
	let prototype = WritableRecord.prototype;
	// define getters and setters for each property so we can track any changes and for getters either return the
	// changed value or the original value from the original record
	for (let key in from) {
		// make the key safe; we could probably add a fast path for safe key names
		let str_key = JSON.stringify(key);
		Object.defineProperty(prototype, key, {
			// this is an eval-free version of the getter, but due to the polymorphic nature of the property access is much slower
			// get() { return prop in this.own ? this.own[prop] : this.data[prop]; },
			// eval-based that allows each function to have monomorphic property access (FAST)
			get: new Function('copy', 'DATA', 'OWN', `
						return function() {
						let v = ${str_key} in this[OWN] ? this[OWN][${str_key}] : this[DATA][${str_key}];
						if (typeof v === 'object' && v && !v.filter) return this[OWN][${str_key}] = copy(v); else return v; };`)(getWritableRecord, DATA, OWN),
			// perhaps eval-based would be here, but expect setters to be less frequently used
			set(value) {
				this[OWN][key] = value;
			},
			enumerable: true,
		});
	}
	return WritableRecord;
}
const SOURCE_RECORD = Symbol('source-record');

function getChanges(target) {
	return target[EXPLICIT_CHANGES_PROPERTY] || (target[EXPLICIT_CHANGES_PROPERTY] = {});
}
export function hasChanges(target) {
	const changes = target[EXPLICIT_CHANGES_PROPERTY];
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
function frozenCopy(target) {
	const changes = target[EXPLICIT_CHANGES_PROPERTY];
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
export function assignObjectAccessors(Target, table_def) {
	const prototype = Target.prototype;
	const descriptors = {};
	for (const attribute of table_def.attributes) {
		const name = attribute.name;
		let descriptor;
		if (attribute.properties) {
			let Class;
			descriptor = {
				get() {
					let copy = this[EXPLICIT_CHANGES_PROPERTY][name];
					if (!copy) {
						const source = this[RECORD_PROPERTY]?.[name];
						if (!source) return source;
						// lazily instantiate in case of recursive structures
						if (!Class) {
							class RecordObject {
								constructor(source) {
									this[SOURCE_RECORD] = source;
								}
							}
							assignObjectAccessors(RecordObject, attribute.properties);
							Class = RecordObject;
						}
						return this[EXPLICIT_CHANGES_PROPERTY][name] = new Class(source);
					}
				},
				set(value) {
					getChanges(this)[name] = value;
				},
				enumerable: true,
			};
		} else {
			descriptor = {
				get(name) {
					const changes = this[EXPLICIT_CHANGES_PROPERTY];
					if (changes?.[name] !== undefined) return changes[name];
					return this[RECORD_PROPERTY]?.[name];
				},
				set(value) {
					getChanges(this)[name] = value;
				},
				enumerable: true,
			};
			switch(attribute.type) {
				case 'String':
					descriptor.set = function(value) {
						if (typeof value !== 'string') throw ClientError(`${name} must be a string, attempt to assign ${value}`);
						getChanges(this)[name] = value;
					};
					break;
				case 'Int':
					descriptor.set = function(value) {
						if (typeof value !== 'number') throw ClientError(`${name} must be a string, attempt to assign ${value}`);
						getChanges(this)[name] = value;
					};
					break;
				case 'array':
					class RecordArray {
						constructor(source) {
							this[SOURCE_RECORD] = source;
						}
					}
					assignArrayAccessors(RecordArray);
					descriptor.set = function(value) {
						if (!Array.isArray(value)) throw ClientError(`${name} must be a string, attempt to assign ${value}`);
						getChanges(this)[name] = value;
					};
					break;


			}
		}
		descriptors[name] = descriptor;
		if (prototype[name] === undefined) {
			Object.defineProperty(prototype, name, descriptor);
		}
	}
	prototype.getProperty = function(name) {
		let descriptor = descriptors[name];
		if (descriptor) return descriptor.set.call(this, value);
		const changes = this[EXPLICIT_CHANGES_PROPERTY];
		if (changes?.[name] !== undefined) return changes[name];
		return this[RECORD_PROPERTY]?.[name];
	};
	prototype.setProperty = function(name, value) {
		let descriptor = descriptors[name];
		if (descriptor) return descriptor.set.call(this, value);
		if (table_def.sealed) throw new ClientError('Can not add a property to a sealed table schema');
		getChanges(this)[name] = value;		
	};
	prototype.deleteProperty = function(name) {
		this[OWN][name] = undefined;
	};
}

class RecordArray extends Array {
	constructor(source) {

	}
	push() {

	}

}


// Copy a record into a resource, using copy-on-write for nested objects/arrays
export function copyRecord(record, target_resource, attributes) {
	target_resource[SOURCE_RECORD] = record;
	for (let attribute of attributes) {
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
