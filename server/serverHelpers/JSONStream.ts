import { Readable } from 'stream';
import JSONbig from 'json-bigint-fixes';
const JSONbigint = JSONbig({ useNativeBigInt: true });
const BUFFER_SIZE = 10000;
const BIGINT_SERIALIZATION = {};
BigInt.prototype.toJSON = function () {
	throw BIGINT_SERIALIZATION;
};
export function streamAsJSON(value) {
	return new JSONStream({ value });
}
// a readable stream for serializing a set of variables to a JSON stream
class JSONStream extends Readable {
	constructor(options) {
		// Calls the stream.Readable(options) constructor
		super(options);
		this.buffer = [];
		this.bufferSize = 0;
		this.iterator = this.serialize(options.value, true);
		this.activeIterators = [];
	}

	*serialize(object) {
		// using a generator to serialize JSON for convenience of recursive pause and resume functionality
		// serialize a value to an iterator that can be consumed by streaming API
		if (object && typeof object === 'object') {
			const hasAsyncIterator = object[Symbol.asyncIterator];
			const hasIterator = object[Symbol.iterator];
			if ((hasIterator || hasAsyncIterator) && !object.then) {
				yield '[';
				let first = true;
				if ((hasAsyncIterator || hasIterator) && !(object instanceof Array)) {
					const iterator = hasAsyncIterator ? object[Symbol.asyncIterator]() : object[Symbol.iterator]();
					this.activeIterators.push(iterator);
					let iteratorResult;
					while (true) {
						iteratorResult = iterator.next();
						if (iteratorResult.then) {
							yield iteratorResult.then((result) => {
								iteratorResult = result;
								return '';
							});
						}
						if (iteratorResult.done) {
							this.activeIterators.splice(this.activeIterators.indexOf(iterator), 1);
							yield ']';
							return;
						} else {
							if (first) {
								first = false;
							} else {
								yield ',';
							}
							yield* this.serialize(iteratorResult.value);
						}
					}
				}
				for (const element of object) {
					if (first) first = false;
					else {
						yield ',';
					}
					yield* this.serialize(element);
				}
				yield ']';
				return;
			}
			if (object.then) {
				try {
					yield object.then((object) => this.serialize(object), handleError);
				} catch (error) {
					yield handleError(error);
				}
			} else {
				yield stringify(object);
			}
		} else {
			yield stringify(object);
		}
	}

	_read() {
		if (this._amReading) {
			// I don't know why _read is called from within a push call, but if we are already reading, ignore the call
			return;
		}
		this._amReading = true;
		if (this.done) {
			return this.push(null);
		}
		when(
			this.readIterator(this.iterator),
			(done) => {
				if (done) {
					this.done = true;
					this.push(null);
				} else {
					this._amReading = false;
				}
			},
			(error) => {
				console.error(error);
				this.done = true;
				this.push(error.toString());
				this.push(null);
			}
		);
	}

	push(content) {
		if (content === null || content instanceof Buffer) {
			if (this.bufferSize > 0) this.flush();
			return super.push(content);
		}
		this.bufferSize += content.length || content.toString().length;
		this.buffer.push(content);
		if (this.bufferSize > BUFFER_SIZE) {
			return this.flush();
		}
		return true;
	}

	flush() {
		const pushResult = super.push(this.buffer.join(''));
		this.buffer = [];
		this.bufferSize = 0;
		return pushResult;
	}

	readIterator(iterator) {
		try {
			// eventually we should be able to just put this around iterator.next()
			let nextString;
			if (iterator.childIterator) {
				// resuming in a child iterator
				return when(this.readIterator(iterator.childIterator), (done) => {
					if (done) {
						iterator.childIterator = null;
						// continue on with the current iterator
						return this.readIterator(iterator);
					}
				});
			}
			do {
				const stepReturn = iterator.next();
				if (stepReturn.done) {
					return true;
				}
				nextString = stepReturn.value;
				if (nextString == null) {
					nextString = 'null';
				} else {
					if (nextString.then) {
						this.flush();
						return Promise.resolve(nextString).then((resolved) => {
							if (resolved && typeof resolved.return === 'function') {
								iterator.childIterator = resolved;
								return this.readIterator(iterator);
							} else if (this.push(resolved + '')) {
								return this.readIterator(iterator);
							} // else return false
						});
					}
					if (typeof nextString.return === 'function') {
						iterator.childIterator = nextString;
						return this.readIterator(iterator);
					}
				}
			} while (this.push(nextString));
		} catch (error) {
			console.error(error);
			this.push(error.toString());
			this.push(null);
			return true;
		}
	}

	_destroy(error, callback) {
		for (const iterator of this.activeIterators) {
			if (error) iterator.throw(error);
			else iterator.return();
		}
		callback();
	}
}

function handleError(error) {
	console.error(error);
	return JSON.stringify(error.toString());
}

function when(promise, callback, errback) {
	if (promise?.then) {
		return errback ? promise.then(callback, errback) : promise.then(callback);
	}
	return callback(promise);
}

export function stringify(value) {
	try {
		return JSON.stringify(value);
	} catch (error) {
		if (error === BIGINT_SERIALIZATION) {
			return jsStringify(value);
		}
		throw error;
	}
}

function jsStringify(value) {
	const type = typeof value;
	if (type === 'object') {
		if (value === null) return 'null';
		if (value.toJSON) value = value.toJSON();
		let str;
		if (Array.isArray(value)) {
			str = '[';
			for (let i = 0; i < value.length; i++) {
				if (i > 0) str += ',';
				// we continue to use jsStringify assuming that if one element has a BigInt, they all do
				str += jsStringify(value[i]);
			}
			return str + ']';
		} else {
			str = '{';
			let first = true;
			for (const key in value) {
				if (first) first = false;
				else str += ',';
				// we assume probably only one element has a BigInt, so we can use stringify for the rest
				str += JSON.stringify(key) + ':' + stringify(value[key]);
			}
			return str + '}';
		}
	} else if (type === 'string') {
		return JSON.stringify(value);
	}
	return value.toString(); // this handles bigint, number, boolean, undefined, symbol
}
const HAS_BIG_NUMBER = /-?\d{16,}/;
export function parse(json) {
	// we use JSONbig if there is a big number in the JSON, otherwise we use the native JSON parser
	// because JSONbig is much slower (about 4x slower)
	if (HAS_BIG_NUMBER.test(json)) return JSONbigint.parse(json);
	else return JSON.parse(json);
}
