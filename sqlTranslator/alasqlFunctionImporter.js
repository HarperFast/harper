/***
 * alasqlFunctionImporter.js
 *
 * PUrpose of this is to set up a central module to define and import custom functions into alasql
 */

const alasql_extension = require('../utility/functions/sql/alaSQLExtension'),
    date_functions = require('../utility/functions/date/dateFunctions'),
    geo = require('../utility/functions/geo');

//import the custom function, need to define an upper and lower case version of the function so it is parsed properly in alasql
module.exports= (alasql)=>{
    /*
    AGGREGATE FUNCTIONS
     */

    alasql.aggr.mad = alasql.aggr.MAD = alasql_extension.mad;
    alasql.aggr.mean = alasql.aggr.MEAN = alasql_extension.mean;
    alasql.aggr.mode = alasql.aggr.MODE = alasql_extension.mode;
    alasql.aggr.prod = alasql.aggr.PROD = alasql_extension.prod;
    //we are overriding alasql's median function as their algorithm is incorrect
    alasql.aggr.median = alasql.aggr.MEDIAN = alasql_extension.median;

    /*
    CUSTOM FUNCTIONS
     */
    alasql.fn.distinct_array = alasql.fn.DISTINCT_ARRAY = alasql_extension.distinct_array;
    alasql.fn.search_json = alasql.fn.SEARCH_JSON = alasql_extension.searchJSON;

    //Date Functions...
    alasql.fn.__ala__ = alasql;
    alasql.fn.current_date = alasql.fn.CURRENT_DATE = date_functions.current_date;
    alasql.fn.current_time = alasql.fn.CURRENT_TIME = date_functions.current_time;
    alasql.fn.extract = alasql.fn.EXTRACT = date_functions.extract;
    alasql.fn.date = alasql.fn.DATE = date_functions.date;
    alasql.fn.date_format = alasql.fn.DATE_FORMAT = date_functions.date_format;
    alasql.fn.date_add = alasql.fn.DATE_ADD = date_functions.date_add;
    alasql.fn.date_sub = alasql.fn.DATE_SUB = date_functions.date_sub;
    alasql.fn.date_diff = alasql.fn.DATE_DIFF = alasql.fn.datediff = alasql.fn.DATEDIFF = date_functions.date_diff;
    alasql.fn.now = alasql.fn.NOW = date_functions.now;
    alasql.fn.offset_utc = alasql.fn.OFFSET_UTC = date_functions.offset_utc;
    alasql.fn.get_server_time = alasql.fn.GET_SERVER_TIME = date_functions.get_server_time;
    //GETDATE() and CURRENT_TIMESTAMP reference the date/time value from NOW() in alasql but we need to monkey patch
    // them here as well with the new now logic
    alasql.fn.getdate = alasql.fn.GETDATE = date_functions.now;
    alasql.fn.current_timestamp = alasql.fn.CURRENT_TIMESTAMP = date_functions.now;

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
