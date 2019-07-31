const FileSystemBridge = require("./fsBridge/FileSystemBridge")

const harper_bridge = new FileSystemBridge();

const getBridge = () => harper_bridge;

module.exports = getBridge();