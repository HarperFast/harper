'use strict';

const chai = require('chai');
const { expect } = chai;
const crypto_hash = require('../../security/cryptoHash');

describe('Test cryptoHash module', () => {
	it('Test createTableStreamName function returns correct stream name', () => {
		const result = crypto_hash.createNatsTableStreamName('funky', 'chicken');
		expect(result).to.equal('0e448e0d0e79e0bc842aac9f15726785');
	});

	it('Test createTableStreamName function returns correct stream name case sensitive', () => {
		const result = crypto_hash.createNatsTableStreamName('Funky', 'Chicken');
		expect(result).to.equal('2dbdc47633db5276fadb245859e0a768');
	});

	it('Test createTableStreamName function returns correct stream name with long name', () => {
		const result = crypto_hash.createNatsTableStreamName('A6RMEvFYUnvFUg9LXdsIjJLZa7eqUYe4EWAtB7fc', 'chicken');
		expect(result).to.equal('81d2c62fe88d0f34c9b91e4add11d3c0');
	});

	it('Test createTableStreamName function returns correct stream name special chars', () => {
		const result = crypto_hash.createNatsTableStreamName('test$dev>.chicken', 'chicken@barn');
		expect(result).to.equal('c1c0d513d3c052f76f6d41b333a778ba');
	});
});
