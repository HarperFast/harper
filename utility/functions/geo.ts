/***
 * geo.js
 *
 * Module created as a wrapper for our implementation of turf.js into the sql parser
 * turf.js has very robust internal validation as such we offload the validation to turf.js
 */

import turfArea from '@turf/area';
import turfLength from '@turf/length';
import turfCircle from '@turf/circle';
import turfDifference from '@turf/difference';
import turfDistance from '@turf/distance';
import turfBooleanContains from '@turf/boolean-contains';
import turfBooleanEqual from '@turf/boolean-equal';
import turfBooleanDisjoint from '@turf/boolean-disjoint';
import * as turfHelpers from '@turf/helpers';
import * as hdbTerms from '../hdbTerms.ts';
import * as commonUtils from '../common_utils.ts';
import hdbLog from '../logging/harper_logger.ts';

export {
	geoArea,
	geoLength,
	geoCircle,
	geoDifference,
	geoDistance,
	geoNear,
	geoContains,
	geoEqual,
	geoCrosses,
	geoConvert,
};
/***
 * Takes one or more features and returns the area in square meters
 * @param geoJSON
 * @returns {number}
 */
function geoArea(geoJSON) {
	if (commonUtils.isEmpty(geoJSON)) {
		return NaN;
	}

	if (typeof geoJSON === 'string') {
		geoJSON = commonUtils.autoCastJSON(geoJSON);
	}
	try {
		return turfArea(geoJSON);
	} catch (err) {
		hdbLog.trace(err, geoJSON);
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
	if (commonUtils.isEmpty(geoJSON)) {
		return NaN;
	}

	if (typeof geoJSON === 'string') {
		geoJSON = commonUtils.autoCastJSON(geoJSON);
	}

	try {
		return turfLength(geoJSON, { units: units ? units : 'kilometers' });
	} catch (err) {
		hdbLog.trace(err, geoJSON);
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
	if (commonUtils.isEmpty(point)) {
		return NaN;
	}

	if (commonUtils.isEmpty(radius)) {
		return NaN;
	}

	if (typeof point === 'string') {
		point = commonUtils.autoCastJSON(point);
	}

	try {
		return turfCircle(point, radius, { units: units ? units : 'kilometers' });
	} catch (err) {
		hdbLog.trace(err, point, radius);
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
	if (commonUtils.isEmpty(poly1)) {
		return NaN;
	}

	if (commonUtils.isEmpty(poly2)) {
		return NaN;
	}

	if (typeof poly1 === 'string') {
		poly1 = commonUtils.autoCastJSON(poly1);
	}

	if (typeof poly2 === 'string') {
		poly2 = commonUtils.autoCastJSON(poly2);
	}

	try {
		return turfDifference(poly1, poly2);
	} catch (err) {
		hdbLog.trace(err, poly1, poly2);
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
	if (commonUtils.isEmpty(point1)) {
		return NaN;
	}

	if (commonUtils.isEmpty(point2)) {
		return NaN;
	}

	if (typeof point1 === 'string') {
		point1 = commonUtils.autoCastJSON(point1);
	}
	if (typeof point2 === 'string') {
		point2 = commonUtils.autoCastJSON(point2);
	}

	try {
		return turfDistance(point1, point2, { units: units ? units : 'kilometers' });
	} catch (err) {
		hdbLog.trace(err, point1, point2);
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
	if (commonUtils.isEmpty(point1)) {
		return false;
	}

	if (commonUtils.isEmpty(point2)) {
		return false;
	}

	if (commonUtils.isEmpty(distance)) {
		throw new Error('distance is required');
	}

	if (typeof point1 === 'string') {
		point1 = commonUtils.autoCastJSON(point1);
	}
	if (typeof point2 === 'string') {
		point2 = commonUtils.autoCastJSON(point2);
	}

	if (isNaN(distance)) {
		throw new Error('distance must be a number');
	}

	try {
		let pointsDistance = geoDistance(point1, point2, units);
		return pointsDistance <= distance;
	} catch (err) {
		hdbLog.trace(err, point1, point2);
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
	if (commonUtils.isEmpty(geo1)) {
		return false;
	}

	if (commonUtils.isEmpty(geo2)) {
		return false;
	}

	if (geo1.coordinates && geo1.coordinates.includes?.(null)) {
		return false;
	}

	if (geo2.coordinates && geo2.coordinates.includes?.(null)) {
		return false;
	}

	if (typeof geo1 === 'string') {
		geo1 = commonUtils.autoCastJSON(geo1);
	}
	if (typeof geo2 === 'string') {
		geo2 = commonUtils.autoCastJSON(geo2);
	}

	try {
		return turfBooleanContains(geo1, geo2);
	} catch (err) {
		hdbLog.trace(err, geo1, geo2);
		return false;
	}
}

/***
 * Determines if geo1 & geo2 are the same type and have identical x,y coordinate values based on: http://edndoc.esri.com/arcsde/9.0/generalTopics/understandSpatialRelations.htm
 * @param geo1
 * @param geo2
 * @returns {boolean}
 */
function geoEqual(geo1, geo2) {
	if (commonUtils.isEmpty(geo1)) {
		return false;
	}

	if (commonUtils.isEmpty(geo2)) {
		return false;
	}

	if (geo1.coordinates && geo1.coordinates.includes?.(null)) {
		return false;
	}

	if (geo2.coordinates && geo2.coordinates.includes?.(null)) {
		return false;
	}

	if (typeof geo1 === 'string') {
		geo1 = commonUtils.autoCastJSON(geo1);
	}
	if (typeof geo2 === 'string') {
		geo2 = commonUtils.autoCastJSON(geo2);
	}

	try {
		return turfBooleanEqual(geo1, geo2);
	} catch (err) {
		hdbLog.trace(err, geo1, geo2);
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
	if (commonUtils.isEmpty(geo1)) {
		return false;
	}

	if (commonUtils.isEmpty(geo2)) {
		return false;
	}

	if (geo1.coordinates && geo1.coordinates.includes?.(null)) {
		return false;
	}

	if (geo2.coordinates && geo2.coordinates.includes?.(null)) {
		return false;
	}

	if (typeof geo1 === 'string') {
		geo1 = commonUtils.autoCastJSON(geo1);
	}
	if (typeof geo2 === 'string') {
		geo2 = commonUtils.autoCastJSON(geo2);
	}

	try {
		//need to do ! as this checks for non-intersections of geometries
		return !turfBooleanDisjoint(geo1, geo2);
	} catch (err) {
		hdbLog.trace(err, geo1, geo2);
		return false;
	}
}

/***
 * Converts a series of coordinates into the desired type
 * @param coordinates
 * @param geoType
 * @param properties
 * @returns {*}
 */
function geoConvert(coordinates, geoType, properties) {
	if (commonUtils.isEmptyOrZeroLength(coordinates)) {
		throw new Error('coordinates is required');
	}

	if (commonUtils.isEmpty(geoType)) {
		throw new Error('geo_type is required');
	}

	if (commonUtils.isEmpty(hdbTerms.GEO_CONVERSION_ENUM[geoType])) {
		throw new Error(
			`geoType of ${geoType} is invalid please use one of the following types: ${Object.keys(
				hdbTerms.GEO_CONVERSION_ENUM
			).join(',')}`
		);
	}

	if (typeof coordinates === 'string') {
		coordinates = commonUtils.autoCastJSON(coordinates);
	}

	return turfHelpers[geoType](coordinates, properties);
}
