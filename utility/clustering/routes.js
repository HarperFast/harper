'use strict';

const config_utils = require('../../config/configUtils');
const hdb_utils = require('../common_utils');
const hdb_terms = require('../hdbTerms');
const routes_validator = require('../../validation/clustering/routesValidator');
const { handleHDBError, hdb_errors } = require('../errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;

const SET_ROUTE_SUCCESS_MSG = 'cluster routes successfully set';

module.exports = {
	setRoutes,
	getRoutes,
	deleteRoutes,
};

/**
 * Add a route/routes to either the hub or leaf server config.
 * Will skip any duplicates that exist between what's in the request and both server configs.
 * @param req
 * @returns {{set: *[], message: string, skipped: *[]}}
 */
function setRoutes(req) {
	const validation = routes_validator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	const all_existing_routes = config_utils.getClusteringRoutes();
	const existing_routes = req.server === 'hub' ? all_existing_routes.hub_routes : all_existing_routes.leaf_routes;
	const other_server_routes = req.server === 'hub' ? all_existing_routes.leaf_routes : all_existing_routes.hub_routes;

	let skipped = [];
	let set = [];
	for (let i = 0, r_length = req.routes.length; i < r_length; i++) {
		const new_route = req.routes[i];
		new_route.port = hdb_utils.autoCast(new_route.port);

		// Check for duplicate routes between servers existing routes and what's in the request.
		const dup = existing_routes.some(
			(ext_route) => ext_route.host === new_route.host && ext_route.port === new_route.port
		);

		// Check for duplicates between the other servers routes and the request.
		const other_dup = other_server_routes.some(
			(other_route) => other_route.host === new_route.host && other_route.port === new_route.port
		);

		if (dup || other_dup) {
			skipped.push(new_route);
		} else {
			existing_routes.push(new_route);
			set.push(new_route);
		}
	}

	if (req.server === 'hub') {
		config_utils.updateConfigValue(
			hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES,
			existing_routes
		);
	} else {
		config_utils.updateConfigValue(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_ROUTES, existing_routes);
	}

	return {
		message: SET_ROUTE_SUCCESS_MSG,
		set,
		skipped,
	};
}

function getRoutes() {}

function deleteRoutes(req) {}
