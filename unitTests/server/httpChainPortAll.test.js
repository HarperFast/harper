'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');

const { httpServer, describeMiddlewareChains } = require('#src/server/http');
const { server } = require('#src/server/Server');

// Ports are never bound here: httpServer()/server.upgrade() only construct a server object and
// register a middleware entry, and threadServer.listenOnPorts() is what binds. Two distinct ports
// so the "an 'all' rebuild doesn't cross-contaminate concrete ports" case is observable.
const PORT = 19418;
const OTHER_PORT = 19419;

const passThrough = (request, next) => next(request);

/**
 * The resolved order of the default (unmounted) route for `port`, restricted to this file's own
 * entries — `httpResponders` is process-global, so a sibling unit test file loaded into the same
 * mocha run can legitimately have registered entries of its own.
 */
function orderFor(kind, port) {
	const routes = describeMiddlewareChains()[kind][port] ?? [];
	const defaultRoute = routes.find((route) => !route.host && !route.urlPath);
	return (defaultRoute?.order ?? []).filter((name) => name.startsWith('chainSync'));
}

describe('http middleware chains and the "all" pseudo-port', () => {
	it('folds a late port:"all" registration into concrete port chains that were already built', () => {
		httpServer(passThrough, { port: PORT, name: 'chainSyncAuthentication' });
		httpServer(passThrough, { port: PORT, name: 'chainSyncRest', after: 'chainSyncAuthentication' });

		assert.deepStrictEqual(orderFor('http', PORT), ['chainSyncAuthentication', 'chainSyncRest']);

		// The shape an application catch-all uses: registered on every port, ordered after Harper's
		// own route ownership, and arriving after the concrete port's chain already exists (#2418).
		httpServer(passThrough, { port: 'all', name: 'chainSyncCatchAll', after: 'chainSyncRest' });

		assert.deepStrictEqual(orderFor('http', PORT), ['chainSyncAuthentication', 'chainSyncRest', 'chainSyncCatchAll']);
	});

	it('applies a late port:"all" registration to every already-built port, not just the newest', () => {
		httpServer(passThrough, { port: OTHER_PORT, name: 'chainSyncOtherPortRest' });
		httpServer(passThrough, { port: 'all', name: 'chainSyncSecondCatchAll', after: 'chainSyncOtherPortRest' });

		assert.ok(orderFor('http', PORT).includes('chainSyncSecondCatchAll'));
		// `chainSyncCatchAll` is on 'all' too, so it belongs to this port's chain as well; its
		// `after: 'chainSyncRest'` names nothing registered here, leaving it in registration order.
		assert.deepStrictEqual(orderFor('http', OTHER_PORT), [
			'chainSyncCatchAll',
			'chainSyncOtherPortRest',
			'chainSyncSecondCatchAll',
		]);
	});

	it('does not leak a concrete port registration into another port chain', () => {
		httpServer(passThrough, { port: OTHER_PORT, name: 'chainSyncOtherPortOnly' });

		assert.ok(!orderFor('http', PORT).includes('chainSyncOtherPortOnly'));
		assert.ok(orderFor('http', OTHER_PORT).includes('chainSyncOtherPortOnly'));
	});

	it('synchronizes upgrade chains on the same terms as http chains', () => {
		server.upgrade(passThrough, { port: PORT, name: 'chainSyncUpgrade' });

		assert.deepStrictEqual(orderFor('upgrade', PORT), ['chainSyncUpgrade']);

		server.upgrade(passThrough, { port: 'all', name: 'chainSyncUpgradeCatchAll', after: 'chainSyncUpgrade' });

		assert.deepStrictEqual(orderFor('upgrade', PORT), ['chainSyncUpgrade', 'chainSyncUpgradeCatchAll']);
	});
});
