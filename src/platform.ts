import {
  API,
  DynamicPlatformPlugin,
  PlatformAccessory,
  Logging,
  PlatformConfig,
  Service,
  Characteristic,
  APIEvent,
  PlatformAccessoryEvent
} from 'homebridge';
import { PLUGIN_NAME, PLATFORM_NAME } from './settings';
import IRobotAccessory from './accessory';

interface DeviceConfig {
  name: string;
  ip: string;
  id: string;
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
	const configuredDevices: DeviceConfig[] = this.config.devices;

	configuredDevices.forEach((deviceConfig: DeviceConfig) => {
	  this.log.info(`Found device: ${deviceConfig.name} with IP: ${deviceConfig.ip}`);
	  const uuid = this.api.hap.uuid.generate(deviceConfig.id);

	  const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

	  if (existingAccessory) {
		this.log.info(`Restoring existing accessory from cache: ${existingAccessory.displayName}`);
		new IRobotAccessory(this.log, deviceConfig, this.api, existingAccessory);
		this.api.updatePlatformAccessories([existingAccessory]);
	  } else {
		this.log.info(`Adding new accessory: ${deviceConfig.name}`);
		
		const accessory = new PlatformAccessory(deviceConfig.name, uuid);
		accessory.context.device = deviceConfig;
		new IRobotAccessory(this.log, deviceConfig, this.api, accessory);

		this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
	  }
	});
  }

  // Required method to configure each accessory
  configureAccessory(accessory: PlatformAccessory): void {
	this.log.info(`Configuring accessory: ${accessory.displayName}`);
	accessory.context.device = accessory.context.device || {};
	new IRobotAccessory(this.log, accessory.context.device, this.api, accessory);
	this.accessories.push(accessory);
  }
}

// Register the platform with Homebridge
export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, IRobotPlatform);
};