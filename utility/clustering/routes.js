'use strict';

const configUtils = require('../../config/configUtils.js');
const hdbUtils = require('../common_utils.js');
const hdbTerms = require('../hdbTerms.ts');
const envMgr = require('../environment/environmentManager.js');
const routesValidator = require('../../validation/clustering/routesValidator.js');
const { handleHDBError, hdbErrors } = require('../errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;

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
	const allExistingRoutes = configUtils.getClusteringRoutes();
	const existingRoutes = req.server === 'hub' ? allExistingRoutes.hub_routes : allExistingRoutes.leaf_routes;
	const otherServerRoutes = req.server === 'hub' ? allExistingRoutes.leaf_routes : allExistingRoutes.hub_routes;

	let skipped = [];
	let set = [];
	for (let i = 0, rLength = req.routes.length; i < rLength; i++) {
		const newRoute = req.routes[i];
		newRoute.port = hdbUtils.autoCast(newRoute.port);

		// Check for duplicate routes between servers existing routes and what's in the request.
		const dup = existingRoutes.some(
			(extRoute) => extRoute.host === newRoute.host && extRoute.port === newRoute.port
		);

		// Check for duplicates between the other servers routes and the request.
		const otherDup = otherServerRoutes.some(
			(otherRoute) => otherRoute.host === newRoute.host && otherRoute.port === newRoute.port
		);

		if (dup || otherDup) {
			skipped.push(newRoute);
		} else {
			existingRoutes.push(newRoute);
			set.push(newRoute);
		}
	}

	if (req.server === 'hub') {
		configUtils.updateConfigValue(
			hdbTerms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES,
			existingRoutes
		);
	} else {
		configUtils.updateConfigValue(hdbTerms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_ROUTES, existingRoutes);
	}

	return {
		message: SET_ROUTE_SUCCESS_MSG,
		set,
		skipped,
	};
}

function setRoutes(req) {
	const validation = routesValidator.setRoutesValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	if (envMgr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		return setRoutesNats(req);
	}

	let set = [];
	let skipped = [];
	const existingRoutes = envMgr.get(hdbTerms.CONFIG_PARAMS.REPLICATION_ROUTES) ?? [];
	req.routes.forEach((r) => {
		if (!existsInArray(existingRoutes, r)) {
			existingRoutes.push(r);
			set.push(r);
		} else {
			skipped.push(r);
		}
	});

	configUtils.updateConfigValue(hdbTerms.CONFIG_PARAMS.REPLICATION_ROUTES, existingRoutes);

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
	if (envMgr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		const allExistingRoutes = configUtils.getClusteringRoutes();
		return {
			hub: allExistingRoutes.hub_routes,
			leaf: allExistingRoutes.leaf_routes,
		};
	} else {
		return envMgr.get(hdbTerms.CONFIG_PARAMS.REPLICATION_ROUTES) ?? [];
	}
}

function deleteRoutes(req) {
	const validation = routesValidator.deleteRoutesValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	if (envMgr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		return deleteRoutesNats(req);
	}

	let deleted = [];
	let skipped = [];
	const existingRoutes = envMgr.get(hdbTerms.CONFIG_PARAMS.REPLICATION_ROUTES) ?? [];
	let updatedRoutes = [];

	existingRoutes.forEach((r) => {
		if (existsInArray(req.routes, r)) {
			deleted.push(r);
		} else {
			updatedRoutes.push(r);
			skipped.push(r);
		}
	});

	configUtils.updateConfigValue(hdbTerms.CONFIG_PARAMS.REPLICATION_ROUTES, updatedRoutes);

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
	const allExistingRoutes = configUtils.getClusteringRoutes();
	let hub_routes = allExistingRoutes.hub_routes;
	let leaf_routes = allExistingRoutes.leaf_routes;
	let deleted = [];
	let skipped = [];

	// Loop through all the routes in the request.
	let hubModified = false;
	let leafModified = false;
	for (let x = 0, rLength = req.routes.length; x < rLength; x++) {
		const reqRoute = req.routes[x];
		let skipLeaf = false;

		// Loop through all existing hub routes, if a match is found remove it from hub routes array.
		for (let y = 0, hLength = hub_routes.length; y < hLength; y++) {
			const hubRoute = hub_routes[y];
			if (reqRoute.host === hubRoute.host && reqRoute.port === hubRoute.port) {
				hub_routes.splice(y, 1);
				skipLeaf = true;
				hubModified = true;
				deleted.push(reqRoute);
				break;
			}
		}

		// Loop through all existing leaf routes, if a match is found remove it from leaf routes array.
		if (!skipLeaf) {
			let notFound = true;
			for (let j = 0, lLength = leaf_routes.length; j < lLength; j++) {
				const leafRoute = leaf_routes[j];
				if (reqRoute.host === leafRoute.host && reqRoute.port === leafRoute.port) {
					leaf_routes.splice(j, 1);
					leafModified = true;
					notFound = false;
					deleted.push(reqRoute);
					break;
				}
			}

			// If the route in the request can't be found in hub or leaf config add it to skipped result array.
			if (notFound) skipped.push(reqRoute);
		}
	}

	if (hubModified) {
		// To avoid setting routes config yaml to empty array we set to null if modified array is empty.
		hub_routes = hdbUtils.isEmptyOrZeroLength(hub_routes) ? null : hub_routes;
		configUtils.updateConfigValue(hdbTerms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES, hub_routes);
	}

	if (leafModified) {
		// To avoid setting routes config yaml to empty array we set to null if modified array is empty.
		leaf_routes = hdbUtils.isEmptyOrZeroLength(leaf_routes) ? null : leaf_routes;
		configUtils.updateConfigValue(hdbTerms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_ROUTES, leaf_routes);
	}

	return {
		message: DELETE_ROUTE_SUCCESS_MSG,
		deleted,
		skipped,
	};
}
