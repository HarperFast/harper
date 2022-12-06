'use strict';

const { Readable } = require('stream');
const BUFFER_SIZE = 10000;

module.exports = {
	streamAsJSON(value) {
		return new JSONStream({ value });
	},
};
// a readable stream for serializing a set of variables to a JSON stream
class JSONStream extends Readable {
	constructor(options) {
		// Calls the stream.Readable(options) constructor
		super(options);
		this.buffer = [];
		this.bufferSize = 0;
		this.iterator = this.serialize(options.value, true);
	}

	*serialize(object) {
		// using a generator to serialize JSON for convenience of recursive pause and resume functionality
		// serialize a value to an iterator that can be consumed by streaming API
		if (object && typeof object === 'object') {
			let hasAsyncIterator = object[Symbol.asyncIterator];
			let hasIterator = object[Symbol.iterator];
			if ((hasIterator || hasAsyncIterator) && !object.then) {
				yield '[';
				let first = true;
				if ((hasAsyncIterator || hasIterator) && !(object instanceof Array)) {
					let iterator = hasAsyncIterator ? object[Symbol.asyncIterator]() : object[Symbol.iterator]();
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
				for (let element of object) {
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
					yield object.then(object => this.serialize(object), handleError);
				} catch (error) {
					yield handleError(error);
				}
			} else {
				yield JSON.stringify(object);
			}
		} else {
			yield JSON.stringify(object);
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
		when(this.readIterator(this.iterator), done => {
			if (done) {
				this.done = true;
				this.push(null);
			} else {
				this._amReading = false;
			}
		}, error => {
			console.error(error);
			this.done = true;
			this.push(error.toString());
			this.push(null);
		})
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
		let pushResult = super.push(this.buffer.join(''));
		this.buffer = [];
		this.bufferSize = 0;
		return pushResult;
	}

	readIterator(iterator) {
		try { // eventually we should be able to just put this around iterator.next()
			let nextString;
			if (iterator.childIterator) {
				// resuming in a child iterator
				return when(this.readIterator(iterator.childIterator), done => {
					if (done) {
						iterator.childIterator = null;
						// continue on with the current iterator
						return this.readIterator(iterator);
					}
				});
			}
			do {
				let stepReturn = iterator.next();
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
}

function handleError(error) {
	console.error(error);
	return JSON.stringify(error.toString());
}

function when(promise, callback, errback) {
	if (promise && promise.then) {
		return errback ?
			promise.then(callback, errback) :
			promise.then(callback);
	}
	return callback(promise);
}
