import dorita980, { RobotMission, RobotState, Roomba } from "dorita980";
import { Local } from "dorita980";
import { CharacteristicEventTypes, Service, Characteristic } from 'hap-nodejs';
import { AccessoryConfig, AccessoryPlugin, API, Logging, Service, CharacteristicValue, CharacteristicGetCallback, CharacteristicSetCallback } from "homebridge";
import { promises as fsPromises } from "fs";
import path from "path";

// Constants
const CONNECT_TIMEOUT_MILLIS = 60_000;
const USER_INTERESTED_MILLIS = 60_000;
const AFTER_ACTIVE_MILLIS = 120_000;
const STATUS_TIMEOUT_MILLIS = 60_000;
const REFRESH_STATE_COALESCE_MILLIS = 10_000;
const ROBOT_CIPHERS = ["AES128-SHA256", "TLS_AES_256_GCM_SHA384"];

// Errors
const NO_VALUE = new Error("No value");

// Helper Functions
async function delay(duration: number): Promise<void> {
  return new Promise((resolve) => {
	setTimeout(resolve, duration);
  });
}

function millisToString(millis: number): string {
  if (millis < 1_000) {
	return `${millis}ms`;
  } else if (millis < 60_000) {
	return `${Math.round((millis / 1000) * 10) / 10}s`;
  } else {
	return `${Math.round((millis / 60_000) * 10) / 10}m`;
  }
}

function shouldTryDifferentCipher(error: Error): boolean {
  if (error.message.indexOf("TLS") !== -1) {
	return true;
  }
  if (error.message.toLowerCase().indexOf("identifier rejected") !== -1) {
	return true;
  }
  return false;
}

interface Config {
  debug?: boolean;
  name: string;
  model: string;
  serialnum: string;
  blid: string;
  robotpwd: string;
  ipaddress: string;
  cleanBehaviour?: string;
  mission?: string;
  stopBehaviour?: string;
  idleWatchInterval?: number;
  dockContactSensor?: boolean;
  runningContactSensor?: boolean;
  binContactSensor?: boolean;
  dockingContactSensor?: boolean;
  homeSwitch?: boolean;
}

interface IRobotStatus {
  running?: boolean;
  batteryLevel?: number;
  charging?: boolean;
  binFull?: boolean;
  docking?: boolean;
  paused?: boolean;
}

export class IRobotAccessory implements AccessoryPlugin {
  private readonly api: API;
  private readonly log: Logging;
  private readonly debug: boolean;
  private readonly name: string;
  private readonly model: string;
  private readonly serialnum: string;
  private readonly blid: string;
  private readonly robotpwd: string;
  private readonly ipaddress: string;
  private readonly cleanBehaviour: string;
  private readonly mission?: string;
  private readonly stopBehaviour: string;
  private readonly idlePollIntervalMillis: number;
  private lastRefreshState: number = 0;
  private lastPollInterval: number = 0;
  private cachedStatus: IRobotStatus = {};
  private _currentIRobotPromise?: Promise<{ IRobot: any, useCount: number }>;
  private currentCipherIndex: number = 0;
  private readonly accessoryInfo: Service;
  private readonly filterMaintenance: Service;
  private readonly switchService: Service;
  private readonly batteryService: Service;
  private dockService?: Service;
  private runningService?: Service;
  private binService?: Service;
  private dockingService?: Service;
  private homeService?: Service;
  private refreshToken?: NodeJS.Timeout;

  constructor(log: Logging, config: Config, api: API) {
	this.api = api;
	this.debug = !!config.debug;

	this.log = !this.debug
	  ? log
	  : Object.assign(log, {
		  debug: (message: string, ...parameters: unknown[]) => {
			log.info(`DEBUG: ${message}`, ...parameters);
		  },
		});
	this.name = config.name;
	this.model = config.model;
	this.serialnum = config.serialnum;
	this.blid = config.blid;
	this.robotpwd = config.robotpwd;
	this.ipaddress = config.ipaddress;
	this.cleanBehaviour = config.cleanBehaviour !== undefined ? config.cleanBehaviour : "everywhere";
	this.mission = config.mission;
	this.stopBehaviour = config.stopBehaviour !== undefined ? config.stopBehaviour : "home";
	this.idlePollIntervalMillis = (config.idleWatchInterval || 15) * 60_000;

	const showDockAsContactSensor = config.dockContactSensor === undefined ? true : config.dockContactSensor;
	const showRunningAsContactSensor = !!config.runningContactSensor;
	const showBinStatusAsContactSensor = !!config.binContactSensor;
	const showDockingAsContactSensor = !!config.dockingContactSensor;
	const showHomeSwitch = !!config.homeSwitch;

	this.accessoryInfo = new this.api.hap.Service.AccessoryInformation();
	this.filterMaintenance = new this.api.hap.Service.FilterMaintenance(this.name);
	this.switchService = new this.api.hap.Service.Switch(this.name);
	this.switchService.setPrimaryService(true);
	this.batteryService = new this.api.hap.Service.BatteryService(this.name);
	if (showDockAsContactSensor) {
	  this.dockService = new this.api.hap.Service.ContactSensor(this.name + " Dock", "docked");
	}
	if (showRunningAsContactSensor) {
	  this.runningService = new this.api.hap.Service.ContactSensor(this.name + " Running", "running");
	}
	if (showBinStatusAsContactSensor) {
	  this.binService = new this.api.hap.Service.ContactSensor(this.name + " Bin Full", "Full");
	}
	if (showDockingAsContactSensor) {
	  this.dockingService = new this.api.hap.Service.ContactSensor(this.name + " Docking", "docking");
	}
	if (showHomeSwitch) {
	  this.homeService = new this.api.hap.Service.Switch(this.name + " Home", "returning");
	}

	const version = require("../package.json").version;

	this.accessoryInfo.setCharacteristic(this.api.hap.Characteristic.Manufacturer, "IRobot");
	this.accessoryInfo.setCharacteristic(this.api.hap.Characteristic.SerialNumber, this.serialnum);
	this.accessoryInfo.setCharacteristic(this.api.hap.Characteristic.Identify, true);
	this.accessoryInfo.setCharacteristic(this.api.hap.Characteristic.Name, this.name);
	this.accessoryInfo.setCharacteristic(this.api.hap.Characteristic.Model, this.model);
	this.accessoryInfo.setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, version);

	// Register Event Handlers
	this.registerEventHandlers();

	this.startPolling();
  }

  private registerEventHandlers() {
	const Characteristic = this.api.hap.Characteristic;
	
	this.switchService
		.getCharacteristic(Characteristic.On)
		.on("set", this.setRunningState.bind(this))
		.on("get", this.createCharacteristicGetter("Running status", this.runningStatus.bind(this)));
  
	this.batteryService
		.getCharacteristic(Characteristic.BatteryLevel)
		.on("get", this.createCharacteristicGetter("Battery level", this.batteryLevelStatus.bind(this)));
  
	this.batteryService
		.getCharacteristic(Characteristic.ChargingState)
		.on("get", this.createCharacteristicGetter("Charging status", this.chargingStatus.bind(this)));
  
	this.batteryService
		.getCharacteristic(Characteristic.StatusLowBattery)
		.on("get", this.createCharacteristicGetter("Low Battery status", this.batteryStatus.bind(this)));
  
	this.filterMaintenance
		.getCharacteristic(Characteristic.FilterChangeIndication)
		.on("get", this.createCharacteristicGetter("Bin status", this.binStatus.bind(this)));
  
	if (this.dockService) {
	  this.dockService
		  .getCharacteristic(Characteristic.ContactSensorState)
		  .on("get", this.createCharacteristicGetter("Dock status", this.dockedStatus.bind(this)));
	}
	if (this.runningService) {
	  this.runningService
		  .getCharacteristic(Characteristic.ContactSensorState)
		  .on("get", this.createCharacteristicGetter("Running status", this.runningStatus.bind(this)));
	}
	if (this.binService) {
	  this.binService
		  .getCharacteristic(Characteristic.ContactSensorState)
		  .on("get", this.createCharacteristicGetter("Bin status", this.binStatus.bind(this)));
	}
	if (this.dockingService) {
	  this.dockingService
		  .getCharacteristic(Characteristic.ContactSensorState)
		  .on("get", this.createCharacteristicGetter("Docking status", this.dockingStatus.bind(this)));
	}
	if (this.homeService) {
	  this.homeService
		  .getCharacteristic(Characteristic.On)
		  .on("set", this.setDockingState.bind(this))
		  .on("get", this.createCharacteristicGetter("Returning Home", this.dockingStatus.bind(this)));
	}
  }  

  identify() {
	this.log.info("Identify requested");
	this.connect((error, IRobot) => {
	  if (error || !IRobot) {
		return;
	  }
	  IRobot.find().catch((err: Error) => {
		this.log.warn("IRobot failed to locate: %s", err.message);
	  });
	});
  }

  getServices(): HBService[] {
	const services = [
	  this.accessoryInfo,
	  this.switchService,
	  this.batteryService,
	  this.filterMaintenance,
	];

	if (this.dockService) {
	  services.push(this.dockService);
	}
	if (this.runningService) {
	  services.push(this.runningService);
	}
	if (this.binService) {
	  services.push(this.binService);
	}
	if (this.dockingService) {
	  services.push(this.dockingService);
	}
	if (this.homeService) {
	  services.push(this.homeService);
	}

	return services;
  }

  private refreshState(callback: (success: boolean) => void) {
	const now = Date.now();

	this.connect((error, IRobot) => {
	  if (error || !IRobot) {
		this.log.warn("Failed to refresh IRobot's state: %s", error ? error.message : "Unknown");
		callback(false);
		return;
	  }

	  const startedWaitingForStatus = Date.now();

	  new Promise<void>((resolve) => {
		let receivedState: IRobotStatus | undefined;

		const timeout = setTimeout(() => {
		  this.log.debug(
			"Timeout waiting for full state from IRobot (%ims). Last state received was: %s",
			Date.now() - startedWaitingForStatus,
			receivedState ? JSON.stringify(receivedState) : "<none>"
		  );
		  resolve();
		  callback(false);
		}, STATUS_TIMEOUT_MILLIS);

		const updateState = (state: IRobotStatus) => {
		  receivedState = state;

		  if (this.receivedRobotStateIsComplete(state)) {
			clearTimeout(timeout);

			this.log.debug(
			  "Refreshed IRobot's state in %ims: %s",
			  Date.now() - now,
			  JSON.stringify(state)
			);

			IRobot.off("state", updateState);
			resolve();
			callback(true);
		  }
		};
		IRobot.on("state", updateState);
	  });
	});
  }

  private receivedRobotStateIsComplete(state: IRobotStatus): boolean {
	return state.batteryLevel !== undefined && state.binFull !== undefined && state.docking !== undefined;
  }

  private receiveRobotState(state: IRobotStatus): boolean {
	const parsed = this.parseState(state);
	this.mergeCachedStatus(parsed);
	return true;
  }

  private connectedIRobot(attempts = 0): Promise<{ IRobot: any, useCount: number }> {
	return new Promise((resolve, reject) => {
	  let connected = false;
	  let failed = false;

	  const IRobot = new Local(this.blid, this.robotpwd, this.ipaddress, 2, {
		ciphers: ROBOT_CIPHERS[this.currentCipherIndex]
	  });

	  const startConnecting = Date.now();
	  const timeout = setTimeout(() => {
		failed = true;
		this.log.debug("Timed out after %ims trying to connect to IRobot", Date.now() - startConnecting);

		IRobot.end();
		reject(new Error("Connect timed out"));
	  }, CONNECT_TIMEOUT_MILLIS);

	  IRobot.on("state", (state: any) => { this.receiveRobotState(state); });

	  const onError = (error: Error) => {
		this.log.debug("Connection received error: %s", error.message);

		IRobot.off("error", onError);
		IRobot.end();
		clearTimeout(timeout);

		if (!connected) {
		  failed = true;

		  if (error instanceof Error && shouldTryDifferentCipher(error) && attempts < ROBOT_CIPHERS.length) {
			this.currentCipherIndex = (this.currentCipherIndex + 1) % ROBOT_CIPHERS.length;
			this.log.debug("Retrying connection to IRobot with cipher %s", ROBOT_CIPHERS[this.currentCipherIndex]);
			this.connectedIRobot(attempts + 1).then(resolve).catch(reject);
		  } else {
			reject(error);
		  }
		}
	  };
	  IRobot.on("error", onError);

	  this.log.debug("Connecting to IRobot...");

	  const onConnect = () => {
		IRobot.off("connect", onConnect);
		clearTimeout(timeout);

		if (failed) {
		  this.log.debug("Connection established to IRobot after failure");
		  return;
		}

		connected = true;

		this.log.debug("Connected to IRobot in %ims", Date.now() - startConnecting);
		resolve({
		  IRobot,
		  useCount: 0,
		});
	  };
	  IRobot.on("connect", onConnect);
	});
  }

  private connect(callback: (error: Error | null, IRobot?: any) => void) {
	const promise = this._currentIRobotPromise || this.connectedIRobot();
	this._currentIRobotPromise = promise;

	promise.then((holder) => {
	  holder.useCount++;
	  Promise.resolve().then(() => {
		callback(null, holder.IRobot);
	  }).finally(() => {
		holder.useCount--;
		if (holder.useCount <= 0) {
		  this._currentIRobotPromise = undefined;
		  holder.IRobot.end();
		} else {
		  this.log.debug("Leaving IRobot instance with %i ongoing requests", holder.useCount);
		}
	  });	  
	}).catch((error) => {
	  this._currentIRobotPromise = undefined;
	  callback(error);
	});
  }

  private setRunningState(powerOn: boolean, callback: (error?: Error) => void) {
	if (powerOn) {
	  this.log.info("Starting IRobot");

	  this.connect((error, IRobot) => {
		if (error || !IRobot) {
		  callback(error || new Error("Unknown error"));
		  return;
		}

		if (this.cachedStatus.paused) {
		  IRobot.resume().then(() => {
			callback();
			this.refreshStatusForUser();
		  }).catch((err: Error) => {
			this.log.warn("IRobot failed: %s", err.message);
			callback(err);
		  });
		} else {
		  if (this.cleanBehaviour === "rooms") {
			IRobot.cleanRoom(this.mission).then(() => {
			  this.log.debug("IRobot is cleaning your rooms");
			  callback();
			  this.refreshStatusForUser();
			}).catch((err: Error) => {
			  this.log.warn("IRobot failed: %s", err.message);
			  callback(err);
			});
		  } else {
			IRobot.clean().then(() => {
			  this.log.debug("IRobot is running");
			  callback();
			  this.refreshStatusForUser();
			}).catch((err: Error) => {
			  this.log.warn("IRobot failed: %s", err.message);
			  callback(err);
			});
		  }
		}
	  });
	} else {
	  this.log.info("Stopping IRobot");

	  this.connect((error, IRobot) => {
		if (error || !IRobot) {
		  callback(error || new Error("Unknown error"));
		  return;
		}

		IRobot.getRobotState(["cleanMissionStatus"]).then((response: IRobotStatus) => {
		  const state = this.parseState(response);

		  if (state.running) {
			this.log.debug("IRobot is pausing");

			IRobot.pause().then(() => {
			  callback();

			  if (this.stopBehaviour === "home") {
				this.log.debug("IRobot paused, returning to Dock");
				this.dockWhenStopped(IRobot, 3000);
			  } else {
				this.log.debug("IRobot is paused");
			  }
			}).catch((err: Error) => {
			  this.log.warn("IRobot failed: %s", err.message);
			  callback(err);
			});
		  } else if (state.docking) {
			this.log.debug("IRobot is docking");
			IRobot.pause().then(() => {
			  callback();
			  this.log.debug("IRobot paused");
			}).catch((err: Error) => {
			  this.log.warn("IRobot failed: %s", err.message);
			  callback(err);
			});
		  } else if (state.charging) {
			this.log.debug("IRobot is already docked");
			callback();
		  } else {
			this.log.debug("IRobot is not running");
			callback();
		  }

		  this.refreshStatusForUser();
		}).catch((err: Error) => {
		  this.log.warn("IRobot failed: %s", err.message);
		  callback(err);
		});
	  });
	}
  }

  private setDockingState(docking: boolean, callback: (error?: Error) => void) {
	this.log.debug("Setting docking state to %s", JSON.stringify(docking));

	this.connect((error, IRobot) => {
	  if (error || !IRobot) {
		callback(error || new Error("Unknown error"));
		return;
	  }

	  if (docking) {
		IRobot.dock().then(() => {
		  this.log.debug("IRobot is docking");
		  callback();
		  this.refreshStatusForUser();
		}).catch((err: Error) => {
		  this.log.warn("IRobot failed: %s", err.message);
		  callback(err);
		});
	  } else {
		IRobot.pause().then(() => {
		  this.log.debug("IRobot is paused");
		  callback();
		  this.refreshStatusForUser();
		}).catch((err: Error) => {
		  this.log.warn("IRobot failed: %s", err.message);
		  callback(err);
		});
	  }
	});
  }

  // Method to dock when stopped
	private async dockWhenStopped(IRobot: any, pollingInterval: number) {
	  try {
		const state = await IRobot.getRobotState(["cleanMissionStatus"]);
  
		switch (state.cleanMissionStatus.phase) {
		  case "stop":
			this.log.debug("IRobot has stopped, issuing dock request");
			await IRobot.dock();
			this.log.debug("IRobot docking");
			this.refreshStatusForUser();
			break;
		  case "run":
			this.log.debug("IRobot is still running. Will check again in %is", pollingInterval / 1000);
			await delay(pollingInterval);
			this.log.debug("Trying to dock again...");
			await this.dockWhenStopped(IRobot, pollingInterval);
			break;
		  default:
			this.log.debug("IRobot is in unexpected state: %s", state.cleanMissionStatus.phase);
			break;
		}
	  } catch (error) {
		this.log.warn("IRobot failed to dock: %s", (error as Error).message);
	  }
	}
  
	refreshStatusForUser() {
	  this.log.debug("Fetching updated status for user");
  
	  if (this.refreshToken) {
		clearTimeout(this.refreshToken);
		this.refreshToken = undefined;
	  }
  
	  this.refreshState((success) => {
		if (success) {
		  this.log.debug("User status updated, scheduling next update");
		  this.scheduleNextUpdate();
		} else {
		  this.log.debug("Failed to update user status");
		}
	  });
	}
  
	scheduleNextUpdate() {
	  this.log.debug("Scheduling next update in %ims", this.idlePollIntervalMillis);
	  this.refreshToken = setTimeout(() => {
		this.log.debug("Executing scheduled update");
		this.refreshStatusForUser();
	  }, this.idlePollIntervalMillis);
	}
  
	parseState(state: any) {
	  const mappedState = {
		running: state.cleanMissionStatus.phase === "run",
		paused: state.cleanMissionStatus.phase === "pause",
		docking: state.cleanMissionStatus.phase === "hmPostMsn",
		batteryLevel: state.batPct,
		charging: state.cleanMissionStatus.phase === "charge",
		binFull: state.bin.full,
	  };
  
	  return mappedState;
	}
  
	mergeCachedStatus(newStatus: any) {
	  this.cachedStatus = Object.assign({}, this.cachedStatus, newStatus);
	  this.lastRefreshState = Date.now();
	}
  
	startPolling() {
	  this.log.debug("Starting poll for device state");
  
	  this.refreshState((success) => {
		if (success) {
		  this.log.debug("Initial state obtained, setting up polling");
		  this.scheduleNextUpdate();
		} else {
		  this.log.debug("Failed to obtain initial state, retrying");
		  setTimeout(() => this.startPolling(), 10_000);
		}
	  });
	}
	private createCharacteristicGetter(name: string, handler: () => any) {
		return (callback: (error: Error | null, data: any) => void) => {
		  this.log.debug(`Getting ${name}`);
		  handler();
		  callback(null, handler());
		};
	  }
	  
	  private runningStatus(): boolean {
		return this.cachedStatus.running ?? false;
	  }
	  
	  private batteryLevelStatus(): number {
		return this.cachedStatus.batteryLevel ?? 0;
	  }
	  
	  private chargingStatus(): boolean {
		return this.cachedStatus.charging ?? false;
	  }
	  
	  private batteryStatus(): number {
		return (this.cachedStatus.batteryLevel ?? 0) < 20 ? 1 : 0;  // Example threshold for low battery
	  }
	  
	  private binStatus(): boolean {
		return this.cachedStatus.binFull ?? false;
	  }
	  
	  private dockedStatus(): boolean {
		return this.cachedStatus.docking ?? false;
	  }
	  
	  private dockingStatus(): boolean {
		return this.cachedStatus.docking ?? false;
	  }	  
  }
  