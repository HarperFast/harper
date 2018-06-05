"use strict";

const turf = require('@turf/turf');

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

function geoArea(geo){
    return turf.area(geo);
}

function geoLength(geo, units){
    return turf.length(geo, {units:units ? units : "kilometers"});
}

function geoCircle(point, radius, units){
    return turf.circle(point, radius, {units:units ? units : "kilometers"});
}

function geoDifference(poly1, poly2){
    return turf.difference(poly1, poly2);
}

function geoDistance(point1, point2, units){
    return turf.distance(point1, point2, {units:units ? units : "kilometers"});
}

function geoNear(point1, point2, distance, units){
    let points_distance = distance(point1, point2, units);
    return points_distance <= distance;
}

function geoContains(geo1, geo2){
    return turf.booleanContains(geo1, geo2);
}

function geoEqual(geo1, geo2){
    return turf.booleanEqual(geo1, geo2);
}

function geoCrosses(geo1, geo2){
    //need to do ! as this checks for non-intersections of geometries
    return !turf.booleanDisjoint(geo1, geo2);
}

function geoConvert(points, converter){
    return turf[converter](points);
}

