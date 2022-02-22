'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const env_manager = require('../../../utility/environment/environmentManager');

describe('Test environmentManager module', () => {
	const sandbox = sinon.createSandbox();

	after(() => {
		sandbox.restore();
	});
});
