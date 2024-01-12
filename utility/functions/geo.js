'use strict';

/***
 * geo.js
 *
 * Module created as a wrapper for our implementation of turf.js into the sql parser
 * turf.js has very robust internal validation as such we offload the validation to turf.js
 */

const turf_area = require('@turf/area');
const turf_length = require('@turf/length');
const turf_circle = require('@turf/circle');
const turf_difference = require('@turf/difference');
const turf_distance = require('@turf/distance');
const turf_booleanContains = require('@turf/boolean-contains');
const turf_booleanEqual = require('@turf/boolean-equal');
const turf_booleanDisjoint = require('@turf/boolean-disjoint');
const turf_helpers = require('@turf/helpers');
const hdb_terms = require('../hdbTerms');
const common_utils = require('../common_utils');
const hdb_log = require('../logging/harper_logger');

module.exports = {
	geoArea: geoArea,
	geoLength: geoLength,
	geoCircle: geoCircle,
	geoDifference: geoDifference,
	geoDistance: geoDistance,
	geoNear: geoNear,
	geoContains: geoContains,
	geoEqual: geoEqual,
	geoCrosses: geoCrosses,
	geoConvert: geoConvert,
};

/***
 * Takes one or more features and returns the area in square meters
 * @param geoJSON
 * @returns {number}
 */
function geoArea(geoJSON) {
	if (common_utils.isEmpty(geoJSON)) {
		return NaN;
	}

	if (typeof geoJSON === 'string') {
		geoJSON = common_utils.autoCastJSON(geoJSON);
	}
	try {
		return turf_area.default(geoJSON);
	} catch (err) {
		hdb_log.trace(err, geoJSON);
		return NaN;
	}
}

/***
 * Takes a GeoJSON and measures its length in the specified units (default is kilometers)
 * @param geoJSON
 * @param units
 * @returns {number}
 */
function geoLength(geoJSON, units) {
	if (common_utils.isEmpty(geoJSON)) {
		return NaN;
	}

	if (typeof geoJSON === 'string') {
		geoJSON = common_utils.autoCastJSON(geoJSON);
	}

	try {
		return turf_length.default(geoJSON, { units: units ? units : 'kilometers' });
	} catch (err) {
		hdb_log.trace(err, geoJSON);
		return NaN;
	}
}

/***
 * Takes a Point and calculates the circle polygon given a radius in units (default units are kilometers)
 * @param point
 * @param radius
 * @param units
 * @returns {Feature<Polygon>}
 */
function geoCircle(point, radius, units) {
	if (common_utils.isEmpty(point)) {
		return NaN;
	}

	if (common_utils.isEmpty(radius)) {
		return NaN;
	}

	if (typeof point === 'string') {
		point = common_utils.autoCastJSON(point);
	}

	try {
		return turf_circle.default(point, radius, { units: units ? units : 'kilometers' });
	} catch (err) {
		hdb_log.trace(err, point, radius);
		return NaN;
	}
}

/***
 * returns a new polygon with the difference of the second polygon clipped from the first polygon
 * @param poly1
 * @param poly2
 * @returns {Feature<Polygon | MultiPolygon> | null}
 */
function geoDifference(poly1, poly2) {
	if (common_utils.isEmpty(poly1)) {
		return NaN;
	}

	if (common_utils.isEmpty(poly2)) {
		return NaN;
	}

	if (typeof poly1 === 'string') {
		poly1 = common_utils.autoCastJSON(poly1);
	}

	if (typeof poly2 === 'string') {
		poly2 = common_utils.autoCastJSON(poly2);
	}

	try {
		return turf_difference(poly1, poly2);
	} catch (err) {
		hdb_log.trace(err, poly1, poly2);
		return NaN;
	}
}

/***
 * Calculates the distance between two points, default unit is kilometers
 * @param point1
 * @param point2
 * @param units
 * @returns {number}
 */
function geoDistance(point1, point2, units) {
	if (common_utils.isEmpty(point1)) {
		return NaN;
	}

	if (common_utils.isEmpty(point2)) {
		return NaN;
	}

	if (typeof point1 === 'string') {
		point1 = common_utils.autoCastJSON(point1);
	}
	if (typeof point2 === 'string') {
		point2 = common_utils.autoCastJSON(point2);
	}

	try {
		return turf_distance.default(point1, point2, { units: units ? units : 'kilometers' });
	} catch (err) {
		hdb_log.trace(err, point1, point2);
		return NaN;
	}
}

/***
 * determines if point1 and point2 are within a specified distance from each other, default units are kilometers
 * @param point1
 * @param point2
 * @param distance
 * @param units
 * @returns {boolean}
 */
function geoNear(point1, point2, distance, units) {
	if (common_utils.isEmpty(point1)) {
		return false;
	}

	if (common_utils.isEmpty(point2)) {
		return false;
	}

	if (common_utils.isEmpty(distance)) {
		throw new Error('distance is required');
	}

	if (typeof point1 === 'string') {
		point1 = common_utils.autoCastJSON(point1);
	}
	if (typeof point2 === 'string') {
		point2 = common_utils.autoCastJSON(point2);
	}

	if (isNaN(distance)) {
		throw new Error('distance must be a number');
	}

	try {
		let points_distance = geoDistance(point1, point2, units);
		return points_distance <= distance;
	} catch (err) {
		hdb_log.trace(err, point1, point2);
		return false;
	}
}

/***
 * Determines if geo2 is completely contained by geo1
 * @param geo1
 * @param geo2
 * @returns {boolean}
 */
function geoContains(geo1, geo2) {
	if (common_utils.isEmpty(geo1)) {
		return false;
	}

	if (common_utils.isEmpty(geo2)) {
		return false;
	}

	if (geo1.coordinates && geo1.coordinates.includes?.(null)) {
		return false;
	}

	if (geo2.coordinates && geo2.coordinates.includes?.(null)) {
		return false;
	}

	if (typeof geo1 === 'string') {
		geo1 = common_utils.autoCastJSON(geo1);
	}
	if (typeof geo2 === 'string') {
		geo2 = common_utils.autoCastJSON(geo2);
	}

	try {
		return turf_booleanContains.default(geo1, geo2);
	} catch (err) {
		hdb_log.trace(err, geo1, geo2);
		return false;
	}
}

/***
 * Determines if geo1 & geo2 are the same type and have identical x,y coordinate values based on: http://edndoc.esri.com/arcsde/9.0/general_topics/understand_spatial_relations.htm
 * @param geo1
 * @param geo2
 * @returns {boolean}
 */
function geoEqual(geo1, geo2) {
	if (common_utils.isEmpty(geo1)) {
		return false;
	}

	if (common_utils.isEmpty(geo2)) {
		return false;
	}

	if (geo1.coordinates && geo1.coordinates.includes?.(null)) {
		return false;
	}

	if (geo2.coordinates && geo2.coordinates.includes?.(null)) {
		return false;
	}

	if (typeof geo1 === 'string') {
		geo1 = common_utils.autoCastJSON(geo1);
	}
	if (typeof geo2 === 'string') {
		geo2 = common_utils.autoCastJSON(geo2);
	}

	try {
		return turf_booleanEqual.default(geo1, geo2);
	} catch (err) {
		hdb_log.trace(err, geo1, geo2);
		return false;
	}
}

/***
 * Determines if the geometries cross over each other
 * @param geo1
 * @param geo2
 * @returns {boolean}
 */
function geoCrosses(geo1, geo2) {
	if (common_utils.isEmpty(geo1)) {
		return false;
	}

	if (common_utils.isEmpty(geo2)) {
		return false;
	}

	if (geo1.coordinates && geo1.coordinates.includes?.(null)) {
		return false;
	}

	if (geo2.coordinates && geo2.coordinates.includes?.(null)) {
		return false;
	}

	if (typeof geo1 === 'string') {
		geo1 = common_utils.autoCastJSON(geo1);
	}
	if (typeof geo2 === 'string') {
		geo2 = common_utils.autoCastJSON(geo2);
	}

	try {
		//need to do ! as this checks for non-intersections of geometries
		return !turf_booleanDisjoint.default(geo1, geo2);
	} catch (err) {
		hdb_log.trace(err, geo1, geo2);
		return false;
	}
}

/***
 * Converts a series of coordinates into the desired type
 * @param coordinates
 * @param geo_type
 * @param properties
 * @returns {*}
 */
function geoConvert(coordinates, geo_type, properties) {
	if (common_utils.isEmptyOrZeroLength(coordinates)) {
		throw new Error('coordinates is required');
	}

	if (common_utils.isEmpty(geo_type)) {
		throw new Error('geo_type is required');
	}

	if (common_utils.isEmpty(hdb_terms.GEO_CONVERSION_ENUM[geo_type])) {
		throw new Error(
			`geo_type of ${geo_type} is invalid please use one of the following types: ${Object.keys(
				hdb_terms.GEO_CONVERSION_ENUM
			).join(',')}`
		);
	}

	if (typeof coordinates === 'string') {
		coordinates = common_utils.autoCastJSON(coordinates);
	}

	return turf_helpers[geo_type](coordinates, properties);
}
