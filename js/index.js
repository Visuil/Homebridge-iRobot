const { API } = require("homebridge");
const { PLATFORM_NAME, PLUGIN_NAME } = require("./settings");
const IRobotPlatform = require("./platform");

/**
 * This method registers the platform with Homebridge
 */
module.exports = (api) => {
    api.registerPlatform(PLATFORM_NAME, IRobotPlatform);
};
