const { raiseTimestampFloor } = require('./rocksdbBindings.mts').rocksdbBindings();

/** `count` representable timestamps above `value` (negative: below). */
function ulpsAbove(value, count) {
	const scratch = new Float64Array([value]);
	new BigInt64Array(scratch.buffer)[0] += BigInt(count);
	return scratch[0];
}

/**
 * `count` ascending timestamps above every one minted so far that the clock will never mint: it is
 * raised past them. One process-wide clock mints for every database and handle, so a test cannot
 * predict a key by counting mints; it sets values aside and places them with `mintNext`.
 */
function setAsideTimestamps(rootStore, count) {
	const base = rootStore.getMonotonicTimestamp();
	const values = Array.from({ length: count }, (_, index) => ulpsAbove(base, index + 1));
	raiseTimestampFloor(values.at(-1));
	return values;
}

/** The next timestamps `rootStore` itself mints are `values`, in order; set them aside first. */
function mintNext(rootStore, ...values) {
	const queue = [...values];
	rootStore.getMonotonicTimestamp = function () {
		const value = queue.shift();
		if (queue.length === 0) delete rootStore.getMonotonicTimestamp;
		return value;
	};
}

module.exports = { mintNext, setAsideTimestamps, ulpsAbove };
