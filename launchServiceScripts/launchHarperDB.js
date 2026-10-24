'use strict';

const { loadRuntimeModule } = require('../utility/packageUtils.js');
loadRuntimeModule('server/threads/nativeAddonGuard');
loadRuntimeModule('launchServiceScripts/startHarperDB');
