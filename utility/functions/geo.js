"use strict";

/***
 * geo.js
 *
 * Module created as a wrapper for our implementation of turf.js into the sql parser
 * turf.js has very robust internal validation as such we offload the validation to turf.js
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
    if(common_utils.isEmpty(geoJSON)){
        throw 'geoJSON is required';
    }

    return turf.area(geoJSON);
}

/***
 * Takes a GeoJSON and measures its length in the specified units (default is kilometers)
 * @param geoJSON
 * @param units
 * @returns {number}
 */
function geoLength(geoJSON, units){
    if(common_utils.isEmpty(geoJSON)){
        throw 'geoJSON is required';
    }

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
    if(common_utils.isEmpty(point)){
        throw 'point is required';
    }

    if(common_utils.isEmpty(radius)){
        throw 'radius is required';
    }

    return turf.circle(point, radius, {units:units ? units : "kilometers"});
}

/***
 * returns a new polygon with the difference of the second polygon clipped from the first polygon
 * @param poly1
 * @param poly2
 * @returns {Feature<Polygon | MultiPolygon> | null}
 */
function geoDifference(poly1, poly2){
    if(common_utils.isEmpty(poly1)){
        throw 'poly1 is required';
    }

    if(common_utils.isEmpty(poly2)){
        throw 'poly2 is required';
    }

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
    if(common_utils.isEmpty(point1)){
        throw 'point1 is required';
    }

    if(common_utils.isEmpty(point2)){
        throw 'point2 is required';
    }

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
    if(common_utils.isEmpty(point1)){
        throw 'point1 is required';
    }

    if(common_utils.isEmpty(point2)){
        throw 'point2 is required';
    }

    if(common_utils.isEmpty(distance)){
        throw new Error('distance is required');
    }

    if(isNaN(distance)){
        throw new Error('distance must be a number');
    }

    let points_distance = geoDistance(point1, point2, units);
    return points_distance <= distance;
}

/***
 * Determines if geo2 is completely contained by geo1
 * @param geo1
 * @param geo2
 * @returns {boolean}
 */
function geoContains(geo1, geo2){
    if(common_utils.isEmpty(geo1)){
        throw 'geo1 is required';
    }

    if(common_utils.isEmpty(geo1)){
        throw 'geo2 is required';
    }


    return turf.booleanContains(geo1, geo2);
}

/***
 * Determines if geo1 & geo2 are the same type and have identical x,y coordinate values based on: http://edndoc.esri.com/arcsde/9.0/general_topics/understand_spatial_relations.htm
 * @param geo1
 * @param geo2
 * @returns {boolean}
 */
function geoEqual(geo1, geo2){
    if(common_utils.isEmpty(geo1)){
        throw 'geo1 is required';
    }

    if(common_utils.isEmpty(geo1)){
        throw 'geo2 is required';
    }


    return turf.booleanEqual(geo1, geo2);
}

/***
 * Determines if the geometries cross over each other
 * @param geo1
 * @param geo2
 * @returns {boolean}
 */
function geoCrosses(geo1, geo2){
    if(common_utils.isEmpty(geo1)){
        throw 'geo1 is required';
    }

    if(common_utils.isEmpty(geo1)){
        throw 'geo2 is required';
    }

    //need to do ! as this checks for non-intersections of geometries
    return !turf.booleanDisjoint(geo1, geo2);
}

/***
 * Converts a series of coordinates into the desired type
 * @param coordinates
 * @param geo_type
 * @param properties
 * @returns {*}
 */
function geoConvert(coordinates, geo_type, properties){
    if(common_utils.isEmpty(geo_type)){
        throw new Error('geo_type is required');
    }

    if(common_utils.isEmpty(hdb_terms.GEO_CONVERSION_ENUM[geo_type])){
        throw new Error(`geo_type of ${geo_type} is invalid please use one of the following types: ${Object.keys(hdb_terms.GEO_CONVERSION_ENUM).join(',')}`);
    }

    return turf[geo_type](coordinates, properties);
}

