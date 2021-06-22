"use strict";

const env = require('../../../utility/environment/environmentManager');
env.initSync();
const terms = require('../../../utility/hdbTerms');

const { HDB_SETTINGS_NAMES } = terms;
const PROPS_CORS_KEY = HDB_SETTINGS_NAMES.CORS_ENABLED_KEY;
const PROPS_CORS_WHITELIST_KEY = HDB_SETTINGS_NAMES.CORS_WHITELIST_KEY;
const TRUE_COMPARE_VAL = 'TRUE';

/**
 * Builds CORS options object to pass to cors plugin when/if it needs to be registered with Fastify
 *
 * @returns {{credentials: boolean, origin: boolean, allowedHeaders: [string, string]}}
 */
function getCORSOptions() {
  let props_cors = env.get(PROPS_CORS_KEY);
  let props_cors_whitelist = env.get(PROPS_CORS_WHITELIST_KEY);
  let cors_options;

  if (props_cors && (props_cors === true || props_cors.toUpperCase() === TRUE_COMPARE_VAL)) {
    cors_options = {
      origin: true,
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: false
    };
    if (props_cors_whitelist && props_cors_whitelist.length > 0) {
      let whitelist = props_cors_whitelist.split(',');
      cors_options.origin = (origin, callback) => {
        if (whitelist.indexOf(origin) !== -1) {
          return callback(null, true);
        }
        return callback(new Error(`domain ${origin} is not whitelisted`));
      };
    }
  }
  return cors_options;
}

module.exports = getCORSOptions;
