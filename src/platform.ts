import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { BambuPrinterAccessory, PrinterConfig } from './printerAccessory';

export class BambuPrintStatusPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

  private readonly printerHandlers: BambuPrinterAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => {
      this.discoverPrinters();
    });

    this.api.on('shutdown', () => {
      this.printerHandlers.forEach((handler) => handler.shutdown());
    });
  }

  // Called by Homebridge for every cached accessory it restores from disk on startup.
  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.push(accessory);
  }

  private discoverPrinters() {
    const printers = (this.config.printers ?? []) as PrinterConfig[];

    if (printers.length === 0) {
      this.log.warn('No printers configured under "printers" for the Bambu Print Status platform.');
      return;
    }

    const activeUuids = new Set<string>();

    for (const printerConfig of printers) {
      if (!printerConfig.ipAddress || !printerConfig.serialNumber || !printerConfig.lanAccessCode) {
        this.log.error(
          `Skipping printer "${printerConfig.name ?? 'unnamed'}" - ipAddress, serialNumber and ` +
            'lanAccessCode are all required.',
        );
        continue;
      }

      const uuid = this.api.hap.uuid.generate(`bambu-print-status-${printerConfig.serialNumber}`);
      activeUuids.add(uuid);

      let accessory = this.accessories.find((a) => a.UUID === uuid);

      if (!accessory) {
        this.log.info(`Registering new accessory: ${printerConfig.name}`);
        accessory = new this.api.platformAccessory(printerConfig.name ?? 'Bambu Printer', uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      }

      this.printerHandlers.push(new BambuPrinterAccessory(this, accessory, printerConfig));
    }

    // Clean up accessories for printers that have been removed from the config.
    const stale = this.accessories.filter((a) => !activeUuids.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale accessory(ies) no longer in config.`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
