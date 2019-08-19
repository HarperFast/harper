"use strict";
const path = require('path');
const env_variable = require('../EnvironmentVariable');
const upgrade_directive = require('../UpgradeDirective');


let sep = path.sep;
let directive = new upgrade_directive('1.3.0');

directive.change_description = ``;

module.exports = directive;


