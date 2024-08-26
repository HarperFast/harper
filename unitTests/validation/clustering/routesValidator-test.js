'use strict';

const chai = require('chai');
const { expect } = chai;
const routes_validator = require('../../../validation/clustering/routesValidator');

describe('Test routesValidator module', () => {
	it('Test invalid server', () => {
		const result = routes_validator.setRoutesValidator({ server: 'harperdb', routes: [] });
		expect(result.message).to.equal("'server' must be one of [hub, leaf]");
	});

	it('Test invalid route object', () => {
		const result = routes_validator.setRoutesValidator({
			server: 'hub',
			routes: [
				{ host: 'test.uni', port: 1111 },
				{ ip: '1.2.3.4', port: 12345 },
			],
		});
		expect(result.message).to.equal("'routes' does not match any of the allowed types");
	});
});
