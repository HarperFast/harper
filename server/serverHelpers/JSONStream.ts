import { Readable } from 'stream';
import * as harperLogger from '../../utility/logging/harper_logger.ts';
import { when } from '../../utility/when.ts';
import JSONbig from 'json-bigint-fixes';
const JSONbigint = JSONbig({ useNativeBigInt: true });
const BUFFER_SIZE = 10000;
const BIGINT_SERIALIZATION = { message: 'Cannot serialize BigInt to JSON' };
(BigInt.prototype as any).toJSON = function () {
	throw BIGINT_SERIALIZATION;
};
const { errorToString } = harperLogger;
function streamError(error) {
	const record: { error: string; replicationUnconfirmed?: true; retryable?: false } = { error: errorToString(error) };
	try {
		if (error?.replicationUnconfirmed === true) {
			record.replicationUnconfirmed = true;
			record.retryable = false;
		} else if (error?.retryable === false) record.retryable = false;
	} catch {}
	return record;
}

export function streamAsJSON(value) {
	return new JSONStream({ value });
}
// a readable stream for serializing a set of variables to a JSON stream
class JSONStream extends Readable {
	buffer: (string | Buffer)[];
	bufferSize: number;
	jsonIterator: Iterator<string | Buffer> | AsyncIterator<string | Buffer>;
	activeIterators: (Iterator<any> | AsyncIterator<any>)[];
	_amReading?: boolean;
	done?: boolean;
	failed?: boolean;

	constructor(options) {
		// Calls the stream.Readable(options) constructor
		super(options);
		this.buffer = [];
		this.bufferSize = 0;
		this.jsonIterator = this.serialize(options.value, true);
		this.activeIterators = [];
	}

	*serialize(object: any, _topLevel?: boolean): Generator<string | Buffer, string | Buffer | void, unknown> {
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
					let failed = false;
					let failure;
					while (true) {
						try {
							iteratorResult = iterator.next();
							if (iteratorResult.then) {
								yield iteratorResult.then(
									(result) => {
										// don't send anything here, assign the iteratorResult and continue
										// with the serialization loop
										iteratorResult = result;
										return ''; // return nothing now and serialization will continue below
									},
									(error) => {
										failed = true;
										failure = error;
										iteratorResult = { done: false, value: streamError(error) };
										return '';
									}
								);
							}
						} catch (error) {
							failed = true;
							failure = error;
							iteratorResult = { done: false, value: streamError(error) };
						}
						if (iteratorResult.done) {
							this.untrackIterator(iterator);
							yield ']';
							return;
						} else {
							if (first) {
								first = false;
							} else {
								yield ',';
							}
							yield* this.serialize(iteratorResult.value);
							if (failed) {
								// the error element is only a diagnostic: no closing bracket, and the throw
								// unwinds every enclosing array so the stream fails instead of ending
								this.untrackIterator(iterator);
								throw failure;
							}
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
				yield object.then((object) => this.serialize(object));
			} else {
				yield stringify(object);
			}
		} else {
			yield stringify(object);
		}
	}

	_read() {
		if (this._amReading || this.failed) {
			// I don't know why _read is called from within a push call, but if we are already reading, ignore the call
			return;
		}
		this._amReading = true;
		if (this.done) {
			return this.push(null);
		}
		when(
			this.readIterator(this.jsonIterator),
			(done) => {
				if (done) {
					this.done = true;
					this.push(null);
				} else {
					this._amReading = false;
				}
			},
			(error) => this.fail(error)
		);
	}

	/**
	 * End the stream as failed rather than complete, so the transport aborts the response instead of
	 * framing what was sent as the whole result.
	 */
	fail(error: unknown) {
		if (this.failed) return;
		this.failed = true;
		if (this.bufferSize > 0) this.flush();
		// destroy() discards unread data, so give the consumer a turn to take the diagnostic element first
		setImmediate(() => this.destroy((error ?? new Error('JSON stream failed')) as Error));
	}

	untrackIterator(iterator: Iterator<any> | AsyncIterator<any>) {
		const activeIndex = this.activeIterators.indexOf(iterator);
		if (activeIndex >= 0) this.activeIterators.splice(activeIndex, 1);
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
			if (!iterator || typeof iterator.next !== 'function') {
				console.error('DEBUG iterator is not valid:', typeof iterator, iterator);
			}
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
			this.fail(error);
			return false;
		}
	}

	_destroy(error, callback) {
		// throw(error) hands the error back when the iterator does not handle it; that is not a cleanup failure
		const onCleanupError = (cleanupError) => {
			if (cleanupError !== error) harperLogger.warn('Error closing a streamed iterator', cleanupError);
		};
		for (const iterator of this.activeIterators) {
			try {
				// an iterator enclosing our own failure did not fail, it just needs closing
				const result = error && !this.failed && iterator.throw ? iterator.throw(error) : iterator.return?.();
				(result as any)?.then?.(null, onCleanupError);
			} catch (cleanupError) {
				onCleanupError(cleanupError);
			}
		}
		// only our own failure is reported as an 'error'; an external destroyer already has its error
		callback(this.failed ? error : null);
	}
}

export function stringify(value) {
	try {
		return JSON.stringify(value) ?? 'null';
	} catch (error) {
		if (error === BIGINT_SERIALIZATION) {
			return jsStringify(value);
		}
		if (error.resolution) {
			return error.resolution.then(() => stringify(value));
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
	} else if (type === 'undefined') {
		return 'null';
	}
	return value.toString(); // this handles bigint, number, boolean, undefined, symbol
}
const HAS_BIG_NUMBER = /[[,:]\s*-?\d{16,}/;
export function parse(json) {
	if (!(json?.length > 0)) return null; // empty string or null
	if (typeof json !== 'string') json = json.toString(); // make sure we just do this once
	// we use JSONbig if there is a big number in the JSON, otherwise we use the native JSON parser
	// because JSONbig is much slower (about 4x slower)
	if (HAS_BIG_NUMBER.test(json)) return JSONbigint.parse(json);
	else return JSON.parse(json);
}
