'use strict';

const config_utils = require('../../config/configUtils');
const hdb_utils = require('../common_utils');
const hdb_terms = require('../hdbTerms');
const env_mgr = require('../environment/environmentManager');
const routes_validator = require('../../validation/clustering/routesValidator');
const { handleHDBError, hdb_errors } = require('../errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;

const SET_ROUTE_SUCCESS_MSG = 'cluster routes successfully set';
const DELETE_ROUTE_SUCCESS_MSG = 'cluster routes successfully deleted';

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
function setRoutesNats(req) {
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

function setRoutes(req) {
	const validation = routes_validator.setRoutesValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	if (env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		return setRoutesNats(req);
	}

	let set = [];
	let skipped = [];
	const existing_routes = env_mgr.get(hdb_terms.CONFIG_PARAMS.REPLICATION_ROUTES) ?? [];
	req.routes.forEach((r) => {
		if (!existsInArray(existing_routes, r)) {
			existing_routes.push(r);
			set.push(r);
		} else {
			skipped.push(r);
		}
	});

	config_utils.updateConfigValue(hdb_terms.CONFIG_PARAMS.REPLICATION_ROUTES, existing_routes);

	return {
		message: SET_ROUTE_SUCCESS_MSG,
		set,
		skipped,
	};
}

function existsInArray(array, value) {
	if (typeof value === 'string') {
		return array.includes(value);
	} else if (typeof value === 'object' && value !== null) {
		return array.some((obj) => (obj.host === value.host || obj.hostname === value.hostname) && obj.port === value.port);
	}
	return false;
}

/**
 * Gets all the hun and leaf servers routes from the harperdb-config.yaml file.
 * @returns {{hub: (*[]|*), leaf: (*[]|*)}}
 */
function getRoutes() {
	if (env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		const all_existing_routes = config_utils.getClusteringRoutes();
		return {
			hub: all_existing_routes.hub_routes,
			leaf: all_existing_routes.leaf_routes,
		};
	} else {
		return env_mgr.get(hdb_terms.CONFIG_PARAMS.REPLICATION_ROUTES) ?? [];
	}
}

function deleteRoutes(req) {
	const validation = routes_validator.deleteRoutesValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	if (env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		return deleteRoutesNats(req);
	}

	let deleted = [];
	let skipped = [];
	const existing_routes = env_mgr.get(hdb_terms.CONFIG_PARAMS.REPLICATION_ROUTES) ?? [];
	let updated_routes = [];

	existing_routes.forEach((r) => {
		if (existsInArray(req.routes, r)) {
			deleted.push(r);
		} else {
			updated_routes.push(r);
			skipped.push(r);
		}
	});

	config_utils.updateConfigValue(hdb_terms.CONFIG_PARAMS.REPLICATION_ROUTES, updated_routes);

	return {
		message: DELETE_ROUTE_SUCCESS_MSG,
		deleted,
		skipped,
	};
}

/**
 * Removes route/routes from hub and/or leaf server routes array in harperdb-config.yaml
 * @param req
 * @returns {{deleted: *[], message: string, skipped: *[]}}
 */
function deleteRoutesNats(req) {
	const all_existing_routes = config_utils.getClusteringRoutes();
	let hub_routes = all_existing_routes.hub_routes;
	let leaf_routes = all_existing_routes.leaf_routes;
	let deleted = [];
	let skipped = [];

	// Loop through all the routes in the request.
	let hub_modified = false;
	let leaf_modified = false;
	for (let x = 0, r_length = req.routes.length; x < r_length; x++) {
		const req_route = req.routes[x];
		let skip_leaf = false;

		// Loop through all existing hub routes, if a match is found remove it from hub routes array.
		for (let y = 0, h_length = hub_routes.length; y < h_length; y++) {
			const hub_route = hub_routes[y];
			if (req_route.host === hub_route.host && req_route.port === hub_route.port) {
				hub_routes.splice(y, 1);
				skip_leaf = true;
				hub_modified = true;
				deleted.push(req_route);
				break;
			}
		}

		// Loop through all existing leaf routes, if a match is found remove it from leaf routes array.
		if (!skip_leaf) {
			let not_found = true;
			for (let j = 0, l_length = leaf_routes.length; j < l_length; j++) {
				const leaf_route = leaf_routes[j];
				if (req_route.host === leaf_route.host && req_route.port === leaf_route.port) {
					leaf_routes.splice(j, 1);
					leaf_modified = true;
					not_found = false;
					deleted.push(req_route);
					break;
				}
			}

			// If the route in the request can't be found in hub or leaf config add it to skipped result array.
			if (not_found) skipped.push(req_route);
		}
	}

	if (hub_modified) {
		// To avoid setting routes config yaml to empty array we set to null if modified array is empty.
		hub_routes = hdb_utils.isEmptyOrZeroLength(hub_routes) ? null : hub_routes;
		config_utils.updateConfigValue(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES, hub_routes);
	}

	if (leaf_modified) {
		// To avoid setting routes config yaml to empty array we set to null if modified array is empty.
		leaf_routes = hdb_utils.isEmptyOrZeroLength(leaf_routes) ? null : leaf_routes;
		config_utils.updateConfigValue(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_ROUTES, leaf_routes);
	}

	return {
		message: DELETE_ROUTE_SUCCESS_MSG,
		deleted,
		skipped,
	};
}
