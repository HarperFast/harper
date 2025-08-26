'use strict';

const wildcardRegex = /[*%]/g;

let self = (module.exports = {
	in: (value, compareArray) => {
		return compareArray._data.indexOf(value) >= 0;
	},
	like: (value, compareValue) => {
		let compareRegex = new RegExp(`^${compareValue.replace(/[*%]/g, '.*?')}$`);
		return compareRegex.test(value);
	},
});
