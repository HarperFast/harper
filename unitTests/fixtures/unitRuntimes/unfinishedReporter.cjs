const { reporters } = require('mocha');
module.exports = class UnfinishedReporter extends reporters.Spec {
	done() {}
};
