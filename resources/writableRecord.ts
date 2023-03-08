
const RECORD_CLASS = Symbol('writable-record-class');
const SOURCE_SYMBOL = Symbol.for('source');
// perhaps we want these in the global registry, not sure:
export const DATA = Symbol('original-data'); // property that references the original (readonly) record for a writable record
export const OWN = Symbol('own'); // property that references an object with any changed properties or cloned/writable sub-objects
const record_class_cache = {}; // we cache the WritableRecord classes because they are pretty expensive to create

/**
 *	A WritableRecord is a wrapper around a cacheable, frozen read-only record, designed to facilitate record updates,
 *	and tracks property (and sub-object/array) changes so that on commit, any property changes can be written as part of
 *	the commit.
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