const { writeFileSync } = require('node:fs');

module.exports = class {
	constructor(runner, options) {
		runner.once('end', () => writeFileSync(options.reporterOptions.destination, 'completed'));
	}
};
