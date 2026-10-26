const assert = require('node:assert');
const { someWhen, everyWhen } = require('#src/utility/when');

describe('someWhen and everyWhen', () => {
	const sync = (value) => value;
	const async = (value) => Promise.resolve(value);

	it('return a plain boolean when every predicate result is synchronous', () => {
		assert.equal(someWhen([false, true], sync), true);
		assert.equal(someWhen([false, false], sync), false);
		assert.equal(someWhen([], sync), false);
		assert.equal(everyWhen([true, true], sync), true);
		assert.equal(everyWhen([true, false], sync), false);
		assert.equal(everyWhen([], sync), true);
	});

	it('resolve a Promise once a predicate returns one', async () => {
		const someResult = someWhen([false, true], async);
		assert(someResult.then);
		assert.equal(await someResult, true);
		assert.equal(await someWhen([false, false], async), false);
		const everyResult = everyWhen([true, true], async);
		assert(everyResult.then);
		assert.equal(await everyResult, true);
		assert.equal(await everyWhen([true, false], async), false);
	});

	it('stop at the first item that decides the result, in order', async () => {
		const tested = [];
		const record = (result) => (item) => {
			tested.push(item);
			return Promise.resolve(result(item));
		};
		assert.equal(
			await someWhen(
				[1, 2, 3],
				record((item) => item === 2)
			),
			true
		);
		assert.deepEqual(tested, [1, 2]);
		tested.length = 0;
		assert.equal(
			await everyWhen(
				[1, 2, 3],
				record((item) => item !== 2)
			),
			false
		);
		assert.deepEqual(tested, [1, 2]);
	});

	it('continue synchronously after an asynchronous result', async () => {
		assert.equal(await someWhen([1, 2], (item) => (item === 1 ? Promise.resolve(false) : true)), true);
		assert.equal(await everyWhen([1, 2], (item) => (item === 1 ? Promise.resolve(true) : false)), false);
	});
});
