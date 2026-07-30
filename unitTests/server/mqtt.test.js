'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { expect } = require('chai');
const sinon = require('sinon');

const { handleApplication } = require('#src/server/mqtt');

// Regression coverage for the split from #1999: MQTT's raw-socket listener must keep
// registering with its own `usageType` so createTLSSelector/getEffectiveTlsCiphers can give
// mqtt-tagged certificates exact-match priority (see unitTests/security/keys.test.js for the
// certificate-selection side of this contract).
describe('mqtt.ts handleApplication raw-socket registration', () => {
	it("registers the raw TCP/TLS listener with usageType 'mqtt'", () => {
		const socketSpy = sinon.spy();
		const scope = {
			options: { getAll: () => ({ network: { securePort: 8883 } }) },
			server: { socket: socketSpy },
		};

		handleApplication(scope);

		expect(socketSpy.calledOnce).to.be.true;
		const options = socketSpy.firstCall.args[1];
		expect(options.usageType).to.equal('mqtt');
	});

	it("still passes usageType 'mqtt' when only a plain (non-TLS) port is configured", () => {
		const socketSpy = sinon.spy();
		const scope = {
			options: { getAll: () => ({ network: { port: 1883 } }) },
			server: { socket: socketSpy },
		};

		handleApplication(scope);

		expect(socketSpy.calledOnce).to.be.true;
		expect(socketSpy.firstCall.args[1].usageType).to.equal('mqtt');
	});
});
