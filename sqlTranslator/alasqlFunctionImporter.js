/***
 * alasqlFunctionImporter.js
 *
 * PUrpose of this is to set up a central module to define and import custom functions into alasql
 */

const alasqlExtension = require('../utility/functions/sql/alaSQLExtension.js'),
	dateFunctions = require('../utility/functions/date/dateFunctions.js'),
	geo = require('../utility/functions/geo.js');

//import the custom function, need to define an upper and lower case version of the function so it is parsed properly in alasql
module.exports = (alasql) => {
	/*
    AGGREGATE FUNCTIONS
     */

	alasql.aggr.mad = alasql.aggr.MAD = alasqlExtension.mad;
	alasql.aggr.mean = alasql.aggr.MEAN = alasqlExtension.mean;
	alasql.aggr.mode = alasql.aggr.MODE = alasqlExtension.mode;
	alasql.aggr.prod = alasql.aggr.PROD = alasqlExtension.prod;
	//we are overriding alasql's median function as their algorithm is incorrect
	alasql.aggr.median = alasql.aggr.MEDIAN = alasqlExtension.median;

	/*
    CUSTOM FUNCTIONS
     */
	alasql.fn.distinct_array = alasql.fn.DISTINCT_ARRAY = alasqlExtension.distinct_array;
	alasql.fn.search_json = alasql.fn.SEARCH_JSON = alasqlExtension.searchJSON;
	alasql.fn.__ala__ = alasql;

	//Date Functions...

	alasql.fn.current_date = alasql.fn.CURRENT_DATE = dateFunctions.current_date;
	alasql.fn.current_time = alasql.fn.CURRENT_TIME = dateFunctions.current_time;
	alasql.fn.extract = alasql.fn.EXTRACT = dateFunctions.extract;
	alasql.fn.date = alasql.fn.DATE = dateFunctions.date;
	alasql.fn.date_format = alasql.fn.DATE_FORMAT = dateFunctions.date_format;
	alasql.fn.date_add = alasql.fn.DATE_ADD = dateFunctions.date_add;
	alasql.fn.date_sub = alasql.fn.DATE_SUB = dateFunctions.date_sub;
	alasql.fn.date_diff = alasql.fn.DATE_DIFF = alasql.fn.datediff = alasql.fn.DATEDIFF = dateFunctions.date_diff;
	alasql.fn.now = alasql.fn.NOW = dateFunctions.now;
	alasql.fn.offset_utc = alasql.fn.OFFSET_UTC = dateFunctions.offset_utc;
	alasql.fn.get_server_time = alasql.fn.GET_SERVER_TIME = dateFunctions.get_server_time;
	//GETDATE() and CURRENT_TIMESTAMP reference the date/time value from NOW() in alasql but we need to monkey patch
	// them here as well with the new now logic
	alasql.fn.getdate = alasql.fn.GETDATE = dateFunctions.now;
	alasql.fn.current_timestamp = alasql.fn.CURRENT_TIMESTAMP = dateFunctions.now;

	/*
    CUSTOM GEO FUNCTIONS
     */
	alasql.fn.geoarea = alasql.fn.GEOAREA = alasql.fn.geoArea = geo.geoArea;
	alasql.fn.geocircle = alasql.fn.GEOCIRCLE = alasql.fn.geoCircle = geo.geoCircle;
	alasql.fn.geocontains = alasql.fn.GEOCONTAINS = alasql.fn.geoContains = geo.geoContains;
	alasql.fn.geoconvert = alasql.fn.GEOCONVERT = alasql.fn.geoConvert = geo.geoConvert;
	alasql.fn.geocrosses = alasql.fn.GEOCROSSES = alasql.fn.geoCrosses = geo.geoCrosses;
	alasql.fn.geodifference = alasql.fn.GEODIFFERENCE = alasql.fn.geoDifference = geo.geoDifference;
	alasql.fn.geodistance = alasql.fn.GEODISTANCE = alasql.fn.geoDistance = geo.geoDistance;
	alasql.fn.geoequal = alasql.fn.GEOEQUAL = alasql.fn.geoEqual = geo.geoEqual;
	alasql.fn.geolength = alasql.fn.GEOLENGTH = alasql.fn.geoLength = geo.geoLength;
	alasql.fn.geonear = alasql.fn.GEONEAR = alasql.fn.geoNear = geo.geoNear;
};
