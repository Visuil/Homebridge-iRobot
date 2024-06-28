const { API, DynamicPlatformPlugin, PlatformAccessory, Logging, PlatformConfig, Service, Characteristic, APIEvent } = require('homebridge');
const { PLUGIN_NAME, PLATFORM_NAME } = require('./settings');
const iRobotAccessory = require('./accessory');

class iRobotPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];

    if (!config || !config.devices || !Array.isArray(config.devices)) {
      this.log.warn('No devices configured');
      return;
    }

    // Listen for the event 'didFinishLaunching' to discover devices
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.log.debug('DidFinishLaunching callback');
      this.discoverDevices();
    });
  }

  // Function to discover and register devices
  discoverDevices() {
    const configuredDevices = this.config.devices;

    configuredDevices.forEach(deviceConfig => {
      this.log.info(`Found device: ${deviceConfig.name} with IP: ${deviceConfig.ip}`);
      const uuid = this.api.hap.uuid.generate(deviceConfig.id);

      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        this.log.info(`Restoring existing accessory from cache: ${existingAccessory.displayName}`);
        new iRobotAccessory(this.log, deviceConfig, this.api, existingAccessory);
        this.api.updatePlatformAccessories([existingAccessory]);
      } else {
        this.log.info(`Adding new accessory: ${deviceConfig.name}`);
        
        const accessory = new PlatformAccessory(deviceConfig.name, uuid);
        accessory.context.device = deviceConfig;
        new iRobotAccessory(this.log, deviceConfig, this.api, accessory);

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    });
  }

  // Required method to configure each accessory
  configureAccessory(accessory) {
    this.log.info(`Configuring accessory: ${accessory.displayName}`);
    accessory.context.device = accessory.context.device || {};
    new iRobotAccessory(this.log, accessory.context.device, this.api, accessory);
    this.accessories.push(accessory);
  }
}

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, iRobotPlatform);
};
