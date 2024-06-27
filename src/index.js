const { API } = require("homebridge");
const { ACCESSORY_NAME, PLUGIN_NAME } = require("./settings");
const iRobotAccessory = require("./accessory");

/**
 * This method registers the platform with Homebridge
 */
module.exports = (api) => {
    api.registerAccessory(PLUGIN_NAME, ACCESSORY_NAME, iRobotAccessory);
};
