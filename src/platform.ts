import { AccessoryConfig, AccessoryPlugin, API, Logging, Service, CharacteristicValue, CharacteristicGetCallback, CharacteristicSetCallback } from "homebridge";
import { PLUGIN_NAME, PLATFORM_NAME } from './settings';
import { IRobotAccessory } from './accessory';
import dorita980, { RobotMission, RobotState, Roomba } from "dorita980";
  
interface DeviceConfig {
	name: string;
	ip: string;
	blid: string;
	password: string;
}
  
class IRobotPlatform implements DynamicPlatformPlugin {
	private readonly log: Logging;
	private readonly config: PlatformConfig;
	private readonly api: API;
	private readonly accessories: PlatformAccessory[];
  
	constructor(log: Logging, config: PlatformConfig, api: API) {
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
	private discoverDevices(): void {
	  dorita980.discovery((ierr: any, devices: any[]) => {
		if (ierr) {
		  this.log.error('Error discovering devices:', ierr);
		  return;
		}
  
		devices.forEach((device: any) => {
		  this.log.info(`Found device: ${device.hostname} with IP: ${device.ip}`);
		  const uuid = this.api.hap.uuid.generate(device.blid);
  
		  const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
  
		  const deviceConfig: DeviceConfig = {
			name: device.hostname,
			ip: device.ip,
			blid: device.blid,
			password: device.password
		  };
  
		  if (existingAccessory) {
			this.log.info(`Restoring existing accessory from cache: ${existingAccessory.displayName}`);
			new IRobotAccessory(this.log, deviceConfig, this.api);
			this.api.updatePlatformAccessories([existingAccessory]);
		  } else {
			this.log.info(`Adding new accessory: ${device.hostname}`);
			const accessory = new this.api.platformAccessory(device.hostname, uuid);
			accessory.context.device = deviceConfig;
			new IRobotAccessory(this.log, deviceConfig, this.api);
			this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
		  }
		});
	  });
	}
  
	// Required method to configure each accessory
	configureAccessory(accessory: PlatformAccessory): void {
	  this.log.info(`Configuring accessory: ${accessory.displayName}`);
	  accessory.context.device = accessory.context.device || {};
	  new IRobotAccessory(this.log, accessory.context.device, this.api);
	  this.accessories.push(accessory);
	}
  }
  
  // Register the platform with Homebridge
  module.exports = (api: API): void =>{
  api.registerPlatform(PLATFORM_NAME, IRobotPlatform);
};

export { IRobotPlatform };