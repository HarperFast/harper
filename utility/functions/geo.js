"use strict";

/***
 * geo.js
 *
 * Module created as a wrapper for our implementation of turf.js into the sql parser
 */

const turf = require('@turf/turf');
const hdb_terms = require('../hdbTerms');
const common_utils = require('../common_utils');

module.exports = {
    geoArea: geoArea,
    geoLength:geoLength,
    geoCircle: geoCircle,
    geoDifference: geoDifference,
    geoDistance :geoDistance,
    geoNear:geoNear,
    geoContains:geoContains,
    geoEqual:geoEqual,
    geoCrosses:geoCrosses,
    geoConvert:geoConvert
};

/***
 * Takes one or more features and returns the area in square meters
 * @param geoJSON
 * @returns {number}
 */
function geoArea(geoJSON){
    return turf.area(geoJSON);
}

/***
 * Takes a GeoJSON and measures its length in the specified units (default is kilometers)
 * @param geoJSON
 * @param units
 * @returns {number}
 */
function geoLength(geoJSON, units){
    return turf.length(geoJSON, {units:units ? units : "kilometers"});
}

/***
 * Takes a Point and calculates the circle polygon given a radius in units (default units are kilometers)
 * @param point
 * @param radius
 * @param units
 * @returns {Feature<Polygon>}
 */
function geoCircle(point, radius, units){
    return turf.circle(point, radius, {units:units ? units : "kilometers"});
}

/***
 * returns a new polygon with the difference of the second polygon clipped from the first polygon
 * @param poly1
 * @param poly2
 * @returns {Feature<Polygon | MultiPolygon> | null}
 */
function geoDifference(poly1, poly2){
    return turf.difference(poly1, poly2);
}

/***
 * Calculates the distance between two points, default unit is kilometers
 * @param point1
 * @param point2
 * @param units
 * @returns {number}
 */
function geoDistance(point1, point2, units){
    return turf.distance(point1, point2, {units:units ? units : "kilometers"});
}

/***
 * determines if point1 and point2 are within a specified distance from each other, default units are kilometers
 * @param point1
 * @param point2
 * @param distance
 * @param units
 * @returns {boolean}
 */
function geoNear(point1, point2, distance, units){
    let points_distance = distance(point1, point2, units);
    return points_distance <= distance;
}

/***
 * Determines if geo2 is completely contained by geo1
 * @param geo1
 * @param geo2
 * @returns {boolean}
 */
function geoContains(geo1, geo2){
    return turf.booleanContains(geo1, geo2);
}

/***
 * Determines if geo1 & geo2 are the same type and have identical x,y coordinate values based on: http://edndoc.esri.com/arcsde/9.0/general_topics/understand_spatial_relations.htm
 * @param geo1
 * @param geo2
 * @returns {boolean}
 */
function geoEqual(geo1, geo2){
    return turf.booleanEqual(geo1, geo2);
}

/***
 * Determines if the geometries cross over each other
 * @param geo1
 * @param geo2
 * @returns {boolean}
 */
function geoCrosses(geo1, geo2){
    //if()
    //need to do ! as this checks for non-intersections of geometries
    return !turf.booleanDisjoint(geo1, geo2);
}

/***
 * Converts a series of points into the desired type
 * @param points
 * @param geo_type
 * @param properties
 * @returns {*}
 */
function geoConvert(points, geo_type, properties){
    if(common_utils.isEmpty(points)){
        throw 'points is required';
    }

    if(common_utils.isEmpty(geo_type)){
        throw 'geo_type is required';
    }

    if(common_utils.isEmpty(hdb_terms.GEO_CONVERSION_ENUM[geo_type])){
        throw `geo_type of ${geo_type} is invalid please use one of the following types: ${Object.keys(hdb_terms.GEO_CONVERSION_ENUM).join(',')}`;
    }

    return turf[geo_type](points, properties);
}

