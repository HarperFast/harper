"use strict";
const path = require('path');
const env_variable = require('../EnvironmentVariable');
const upgrade_directive = require('../UpgradeDirective');

let directive = new upgrade_directive('1.3.001');

directive.environment_variables.push(
    new env_variable(`ALLOW_SELF_SIGNED_SSL_CERTS`, `false`, [])
);

module.exports = directive;