import {
  API,
  DynamicPlatformPlugin,
  PlatformAccessory,
  Logging,
  PlatformConfig,
  APIEvent,
} from 'homebridge';
import { PLUGIN_NAME, PLATFORM_NAME } from './settings';
import { IRobotAccessory } from './accessory';  // Ensure IRobotAccessory is a named export from accessory.ts
import dorita980 from 'dorita980';

interface DeviceConfig {
  name: string;
  ip: string;
  id: string;
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
	dorita980.discovery((ierr, devices) => {
	  if (ierr) {
		this.log.error('Error discovering devices:', ierr);
		return;
	  }

	  devices.forEach((device: any) => {
		this.log.info(`Found device: ${device.hostname} with IP: ${device.ipv4}`);
		const uuid = this.api.hap.uuid.generate(device.blid);

		const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

		const deviceConfig: DeviceConfig = {
		  name: device.hostname,
		  ip: device.ipv4,
		  id: device.blid,
		  blid: device.blid,
		  password: device.password
		};

		if (existingAccessory) {
		  this.log.info(`Restoring existing accessory from cache: ${existingAccessory.displayName}`);
		  new IRobotAccessory(this.log, deviceConfig, this.api, existingAccessory);
		  this.api.updatePlatformAccessories([existingAccessory]);
		} else {
		  this.log.info(`Adding new accessory: ${device.hostname}`);
		  const accessory = new PlatformAccessory(device.hostname, uuid);
		  accessory.context.device = deviceConfig;
		  new IRobotAccessory(this.log, deviceConfig, this.api, accessory);
		  this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
		}
	  });
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

export { IRobotPlatform };