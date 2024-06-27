const { API } = require("homebridge");
const { PLATFORM_NAME, PLUGIN_NAME } = require("./settings");
const IRobotAccessory = require("./accessory");

/**
 * This method registers the platform with Homebridge
 */
module.exports = (api) => {
    api.registerAccessory(PLUGIN_NAME, PLATFORM_NAME, IRobotAccessory);
};
