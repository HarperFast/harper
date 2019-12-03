"use strict";
const path = require('os');
const env_variable = require('../EnvironmentVariable');
const upgrade_directive = require('../UpgradeDirective');

let directives = [];
let directive_1_3_0 = new upgrade_directive('1.3.0');
directive_1_3_0.change_description = `Version 1.3.0`;
directives.push(directive_1_3_0);
let directive_1_3_1 = new upgrade_directive('1.3.1');
directive_1_3_1.change_description = `Version 1.3.1`;
directives.push(directive_1_3_1);
let directive_1_3_001 = new upgrade_directive('1.3.001');
directive_1_3_001.change_description = `Version 1.3.001`;
directives.push(directive_1_3_001);
let directive_1_3_2 = new upgrade_directive('1.3.2');
directive_1_3_2.change_description = `Version 1.3.2`;
directives.push(directive_1_3_2);
let directive_1_3_1002 = new upgrade_directive('1.3.1002');
directive_1_3_1002.change_description = `Version 1.3.1002`;
directives.push(directive_1_3_1002);

module.exports = directives;


