import { Service, PlatformAccessory } from 'homebridge';
import * as mqtt from 'mqtt';
import { Client as FtpClient } from 'basic-ftp';
import { Writable } from 'stream';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { BambuPrintStatusPlatform } from './platform';
import { BAMBU_ERROR_CODES, KNOWN_FILAMENT_RUNOUT_CODES } from './bambuErrorCodes';

export interface PrinterConfig {
  name: string;
  ipAddress: string;
  serialNumber: string;
  lanAccessCode: string;
  mqttPort?: number;
  mqttUsername?: string;
  rejectUnauthorized?: boolean;
  refreshIntervalSeconds?: number;
  reconnectDelaySeconds?: number;
  // gcode_state values that should be treated as "occupied" (printer actively in use).
  activeStates?: string[];
  // print_error codes (as reported by the printer, e.g. "83935248") confirmed to mean
  // "out of filament" on your printer/firmware. Leave empty until you've triggered a
  // real runout and read the logged code - see README.
  filamentRunoutErrorCodes?: string[];

  // Pingie "Notify!" group push notifications - both are required to enable notifications.
  // Get these from the Notify! app (Group settings), or GET /link on notifypush.pingie.com
  // to confirm them.
  pingieGroupId?: string;
  pingieGroupToken?: string;
  pingieIconUrl?: string;
  pingieImageUrl?: string;

  // Used to estimate electricity cost for a print. Both required for cost estimates -
  // duration-only notifications still work without them.
  averagePrintWattage?: number;
  electricityRatePencePerKwh?: number;

  // Sends a Pingie push every N percent of progress (e.g. 5 -> notifications at
  // 5%, 10%, 15%...), each with the printer's current estimated time remaining.
  // Set to 0 to disable. Defaults to 5.
  progressNotificationIntervalPercent?: number;

  // Delays the "Print started" Pingie push (not the HomeKit switch, which
  // still fires instantly) by this many seconds, giving mc_remaining_time a
  // chance to populate with this print's real estimate rather than showing
  // "no estimate yet" or a stale value left over from a previous print.
  startNotificationDelaySeconds?: number;

  // Attaches a live camera snapshot (as the notification icon, shown immediately
  // rather than only on tap) pulled from camera.ui's own REST API - reuses the
  // connection camera.ui already holds rather than opening a second one to the
  // printer. Uploaded to a public GitHub repo via the Contents API (overwriting
  // one fixed file each time) since Pingie's servers need a public HTTPS URL.
  includeCameraSnapshot?: boolean;
  cameraUiBaseUrl?: string;
  cameraUiUsername?: string;
  cameraUiPassword?: string;
  cameraUiCameraName?: string;
  githubToken?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubSnapshotPath?: string;
  githubBranch?: string;

  // Price per kg by material type (e.g. {"PLA": 18.99, "PETG": 22.99}), used
  // to cost out the filament actually used in a finished print, read from the
  // sliced 3MF file's own metadata via FTP rather than AMS remaining-%
  // tracking (which only works for genuine Bambu RFID spools). A material not
  // in this map still shows its weight, just without a cost figure.
  filamentPricesPerKg?: Record<string, number>;
}

const DEFAULT_ACTIVE_STATES = ['RUNNING', 'PREPARE', 'PAUSE', 'SLICING'];

export class BambuPrinterAccessory {
  private readonly service: Service;
  private readonly lightService: Service;
  private readonly progressService: Service;
  private readonly speedService: Service;
  private readonly pauseService: Service;
  private readonly startedSwitchService: Service;
  private readonly finishedSwitchService: Service;
  private readonly faultService: Service;
  private readonly filamentService: Service;
  private client?: mqtt.MqttClient;
  private chamberLightOn = false;
  private currentlyPaused = false;
  private faultPresent = false;
  private filamentOut = false;
  private previousGcodeState?: string;
  private printProgressPercent = 0;
  // 1=Silent, 2=Standard, 3=Sport, 4=Ludicrous. Tracked optimistically from
  // our own commands; also reconciled against the printer's own spd_lvl
  // field when present in the report (moderate, not fully verified confidence
  // in that exact field name - falls back to optimistic tracking if absent).
  private currentSpeedLevel = 2;
  private printStartTimestamp?: number;
  private printEstimatedTotalMinutes?: number;
  private lastNotifiedProgressBucket = -1;
  private cameraUiToken?: string;
  private cameraUiTokenExpiresAt = 0;
  private startNotificationTimer?: ReturnType<typeof setTimeout>;

  // Bambu printers send partial diffs after the first message, so we keep a
  // merged copy of everything we've seen rather than trusting any single message.
  private mergedState: Record<string, unknown> = {};
  private currentlyOccupied = false;

  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private readonly activeStates: string[];

  constructor(
    private readonly platform: BambuPrintStatusPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly printerConfig: PrinterConfig,
  ) {
    this.activeStates =
      printerConfig.activeStates && printerConfig.activeStates.length > 0
        ? printerConfig.activeStates
        : DEFAULT_ACTIVE_STATES;

    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation);
    if (infoService) {
      infoService
        .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Bambu Lab')
        .setCharacteristic(this.platform.Characteristic.Model, 'Bambu Printer')
        .setCharacteristic(this.platform.Characteristic.SerialNumber, printerConfig.serialNumber);
    }

    this.service =
      this.accessory.getService(this.platform.Service.OccupancySensor) ||
      this.accessory.addService(this.platform.Service.OccupancySensor, printerConfig.name);

    this.service.setCharacteristic(this.platform.Characteristic.Name, printerConfig.name);

    this.service
      .getCharacteristic(this.platform.Characteristic.OccupancyDetected)
      .onGet(() =>
        this.currentlyOccupied
          ? this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
          : this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
      );

    // StatusActive marks the sensor's reading as untrustworthy while we're
    // disconnected, so an automation doesn't read "no connection" as "idle"
    // and kill power to the printer mid-print.
    if (!this.service.testCharacteristic(this.platform.Characteristic.StatusActive)) {
      this.service.addCharacteristic(this.platform.Characteristic.StatusActive);
    }
    this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, false);

    // Chamber light - reads back real state from the printer's lights_report,
    // and sends the on/off command over the same MQTT connection.
    this.lightService =
      this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb, `${printerConfig.name} Light`);

    this.lightService.setCharacteristic(
      this.platform.Characteristic.Name,
      `${printerConfig.name} Light`,
    );

    this.lightService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.chamberLightOn)
      .onSet((value) => this.setChamberLight(value as boolean));

    // Print progress - no native HomeKit "progress bar" exists, so this uses
    // the common workaround of a Fan's rotation speed slider (0-100%), driven
    // by the printer's own reported mc_percent rather than a time-based
    // estimate. Active/RotationSpeed are read-only display - any attempt to
    // change them from the Home app just snaps back to the real value.
    this.progressService =
      this.accessory.getServiceById(this.platform.Service.Fanv2, 'progress') ||
      this.accessory.addService(this.platform.Service.Fanv2, `${printerConfig.name} Progress`, 'progress');
    this.progressService.setCharacteristic(
      this.platform.Characteristic.Name,
      `${printerConfig.name} Progress`,
    );
    this.progressService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() =>
        this.currentlyOccupied
          ? this.platform.Characteristic.Active.ACTIVE
          : this.platform.Characteristic.Active.INACTIVE,
      )
      .onSet(() => {
        // Read-only: revert any manual toggle back to the real state.
        setTimeout(
          () =>
            this.progressService.updateCharacteristic(
              this.platform.Characteristic.Active,
              this.currentlyOccupied
                ? this.platform.Characteristic.Active.ACTIVE
                : this.platform.Characteristic.Active.INACTIVE,
            ),
          0,
        );
      });
    this.progressService
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => this.printProgressPercent)
      .onSet(() => {
        // Read-only: revert any manual drag back to the real percentage.
        setTimeout(
          () =>
            this.progressService.updateCharacteristic(
              this.platform.Characteristic.RotationSpeed,
              this.printProgressPercent,
            ),
          0,
        );
      });

    // Print speed profile - HomeKit has no native 4-way selector, so this
    // reuses the same Fan-slider trick as Progress, snapped to exactly 4
    // positions: 25%=Silent, 50%=Standard, 75%=Sport, 100%=Ludicrous. Real
    // limitation: the Home app only shows a percentage, not the profile name
    // - there's no way to label slider positions in stock Home app.
    this.speedService =
      this.accessory.getServiceById(this.platform.Service.Fanv2, 'speed') ||
      this.accessory.addService(this.platform.Service.Fanv2, `${printerConfig.name} Speed`, 'speed');
    this.speedService.setCharacteristic(this.platform.Characteristic.Name, `${printerConfig.name} Speed`);
    this.speedService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() =>
        this.currentlyOccupied
          ? this.platform.Characteristic.Active.ACTIVE
          : this.platform.Characteristic.Active.INACTIVE,
      )
      .onSet(() => {
        setTimeout(
          () =>
            this.speedService.updateCharacteristic(
              this.platform.Characteristic.Active,
              this.currentlyOccupied
                ? this.platform.Characteristic.Active.ACTIVE
                : this.platform.Characteristic.Active.INACTIVE,
            ),
          0,
        );
      });
    this.speedService
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 25, maxValue: 100, minStep: 25 })
      .onGet(() => this.currentSpeedLevel * 25)
      .onSet((value) => this.setPrintSpeed(Math.round((value as number) / 25)));

    // Pause/Resume - a genuine two-state Switch (unlike Stop, this is safely
    // reversible): On while the printer is paused, Off while running. Reflects
    // real gcode_state so it stays in sync if paused/resumed from the touchscreen.
    this.pauseService =
      this.accessory.getService(this.platform.Service.Switch) ||
      this.accessory.addService(this.platform.Service.Switch, `${printerConfig.name} Pause`);
    this.pauseService.setCharacteristic(this.platform.Characteristic.Name, `${printerConfig.name} Pause`);
    this.pauseService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.currentlyPaused)
      .onSet((value) => this.setPauseState(value as boolean));

    // Print-started / print-finished notifications - each fires a single "press"
    // on its transition, and separately triggers a Pingie push with the duration
    // estimate (started) or actual elapsed time (finished), plus an electricity
    // cost estimate if averagePrintWattage/electricityRatePencePerKwh are set.
    this.startedSwitchService =
      this.accessory.getServiceById(this.platform.Service.StatelessProgrammableSwitch, 'started') ||
      this.accessory.addService(
        this.platform.Service.StatelessProgrammableSwitch,
        `${printerConfig.name} Started`,
        'started',
      );
    this.startedSwitchService.setCharacteristic(
      this.platform.Characteristic.Name,
      `${printerConfig.name} Started`,
    );
    this.startedSwitchService
      .getCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent)
      .setProps({
        validValues: [this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS],
      });

    this.finishedSwitchService =
      this.accessory.getServiceById(this.platform.Service.StatelessProgrammableSwitch, 'finished') ||
      this.accessory.addService(
        this.platform.Service.StatelessProgrammableSwitch,
        `${printerConfig.name} Finished`,
        'finished',
      );
    this.finishedSwitchService.setCharacteristic(
      this.platform.Characteristic.Name,
      `${printerConfig.name} Finished`,
    );
    this.finishedSwitchService
      .getCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent)
      .setProps({
        validValues: [this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS],
      });

    // Fault/error alert - Contact Sensor semantics: DETECTED = normal (closed),
    // NOT_DETECTED = fault present (open) - this makes it trigger cleanly as an
    // "opened" event in Home app automations.
    this.faultService =
      this.accessory.getServiceById(this.platform.Service.ContactSensor, 'fault') ||
      this.accessory.addService(
        this.platform.Service.ContactSensor,
        `${printerConfig.name} Fault`,
        'fault',
      );
    this.faultService.setCharacteristic(this.platform.Characteristic.Name, `${printerConfig.name} Fault`);
    this.faultService
      .getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(() =>
        this.faultPresent
          ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );

    // Filament run-out - same Contact Sensor pattern, driven by user-confirmed
    // print_error codes (see requestFullState/handleMessage for how codes surface).
    this.filamentService =
      this.accessory.getServiceById(this.platform.Service.ContactSensor, 'filament') ||
      this.accessory.addService(
        this.platform.Service.ContactSensor,
        `${printerConfig.name} Filament`,
        'filament',
      );
    this.filamentService.setCharacteristic(
      this.platform.Characteristic.Name,
      `${printerConfig.name} Filament`,
    );
    this.filamentService
      .getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(() =>
        this.filamentOut
          ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );

    this.connect();
  }

  private hexKeyForCode(code: number): string {
    const hex = (code >>> 0).toString(16).toUpperCase().padStart(8, '0');
    return `${hex.slice(0, 4)}_${hex.slice(4, 8)}`;
  }

  // Looks up a human-readable description via the bundled community mapping.
  // Returns undefined if the code isn't in the table (or maps to an empty
  // string in the source data) - callers should fall back to the raw code.
  private describeError(code: number): string | undefined {
    const desc = BAMBU_ERROR_CODES[this.hexKeyForCode(code)];
    return desc && desc.length > 0 ? desc : undefined;
  }

  // Sends the print_speed MQTT command. There's a documented firmware bug
  // (confirmed on P1 series, plausibly others) where sending "param" as
  // anything other than a proper JSON string "1"-"4" causes a type-confusion
  // bug producing a garbage speed multiplier (one user saw 510%) - so this
  // only ever accepts the four valid levels and always forces param through
  // String() explicitly, never a bare number.
  private setPrintSpeed(level: number) {
    if (![1, 2, 3, 4].includes(level)) {
      this.platform.log.warn(`[${this.printerConfig.name}] Ignoring invalid print speed level: ${level}`);
      setTimeout(
        () => this.speedService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.currentSpeedLevel * 25),
        0,
      );
      return;
    }
    if (!this.client || !this.client.connected) {
      this.platform.log.warn(`[${this.printerConfig.name}] Can't set print speed - not connected.`);
      setTimeout(
        () => this.speedService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.currentSpeedLevel * 25),
        0,
      );
      return;
    }

    const payload = JSON.stringify({
      print: { sequence_id: '0', command: 'print_speed', param: String(level) },
    });
    this.client.publish(`device/${this.printerConfig.serialNumber}/request`, payload);
    this.currentSpeedLevel = level; // optimistic; reconciled against spd_lvl if/when it arrives
    const names = ['', 'Silent', 'Standard', 'Sport', 'Ludicrous'];
    this.platform.log.info(`[${this.printerConfig.name}] Print speed -> ${names[level]}`);
  }

  private setPauseState(pause: boolean) {
    if (!this.client || !this.client.connected) {
      this.platform.log.warn(`[${this.printerConfig.name}] Can't ${pause ? 'pause' : 'resume'} - not connected.`);
      setTimeout(() => this.pauseService.updateCharacteristic(this.platform.Characteristic.On, this.currentlyPaused), 0);
      return;
    }

    const command = pause ? 'pause' : 'resume';
    const payload = JSON.stringify({
      print: { sequence_id: '0', command },
    });
    this.client.publish(`device/${this.printerConfig.serialNumber}/request`, payload);
    this.currentlyPaused = pause; // optimistic; the next report reconciles it if wrong
    this.platform.log.info(`[${this.printerConfig.name}] Sent ${command}`);
  }

  private setChamberLight(on: boolean) {
    if (!this.client || !this.client.connected) {
      this.platform.log.warn(`[${this.printerConfig.name}] Can't set light - not connected.`);
      // Revert the UI optimistic toggle since the command can't be sent.
      setTimeout(() => this.lightService.updateCharacteristic(this.platform.Characteristic.On, this.chamberLightOn), 0);
      return;
    }

    const payload = JSON.stringify({
      system: {
        sequence_id: '0',
        command: 'ledctrl',
        led_node: 'chamber_light',
        led_mode: on ? 'on' : 'off',
        led_on_time: 500,
        led_off_time: 500,
        loop_times: 0,
        interval_time: 0,
      },
    });

    this.client.publish(`device/${this.printerConfig.serialNumber}/request`, payload);
    this.chamberLightOn = on;
    this.platform.log.info(`[${this.printerConfig.name}] Chamber light -> ${on ? 'ON' : 'OFF'}`);
  }

  // Logs into camera.ui and caches the JWT until it's close to expiring.
  // Returns undefined if camera.ui isn't configured or login fails.
  private async getCameraUiToken(): Promise<string | undefined> {
    const { cameraUiBaseUrl, cameraUiUsername, cameraUiPassword } = this.printerConfig;
    if (!cameraUiBaseUrl || !cameraUiUsername || !cameraUiPassword) {
      return undefined;
    }

    // Refresh a bit before actual expiry rather than cutting it exactly fine.
    if (this.cameraUiToken && Date.now() < this.cameraUiTokenExpiresAt - 30_000) {
      return this.cameraUiToken;
    }

    try {
      const res = await fetch(`${cameraUiBaseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cameraUiUsername, password: cameraUiPassword }),
      });
      if (!res.ok) {
        this.platform.log.warn(`[${this.printerConfig.name}] camera.ui login failed (${res.status}).`);
        return undefined;
      }
      const body = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!body.access_token) {
        this.platform.log.warn(`[${this.printerConfig.name}] camera.ui login response had no access_token.`);
        return undefined;
      }
      this.cameraUiToken = body.access_token;
      this.cameraUiTokenExpiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
      return this.cameraUiToken;
    } catch (err) {
      this.platform.log.warn(`[${this.printerConfig.name}] camera.ui login error: ${(err as Error).message}`);
      return undefined;
    }
  }

  // Pulls a snapshot from camera.ui's own cached camera feed rather than
  // opening a second connection to the printer directly. Retries once with a
  // fresh login if the cached token turns out to be stale (401).
  // Fetches the current print's sliced .3mf project file over FTPS and parses
  // its embedded slicer metadata to get per-material filament weight - this
  // works for ANY filament (genuine or third-party), unlike AMS remaining-%
  // tracking which only works for genuine Bambu RFID spools. The exact 3MF
  // internal path and XML attribute names aren't independently verified here,
  // so on any mismatch this logs the raw content it found rather than
  // guessing - check the log and adjust if your Studio version differs.
  private async fetchFilamentUsage(): Promise<{ type: string; grams: number }[] | undefined> {
    const subtaskNameRaw = this.mergedState.subtask_name as string | undefined;
    if (!subtaskNameRaw) {
      this.platform.log.warn(`[${this.printerConfig.name}] No subtask_name available - can't locate the project file.`);
      return undefined;
    }
    const subtaskName = subtaskNameRaw.toLowerCase().endsWith('.3mf') ? subtaskNameRaw : `${subtaskNameRaw}.3mf`;
    const candidatePaths = [`/cache/${subtaskName}`, `/${subtaskName}`];

    const client = new FtpClient();
    client.ftp.verbose = false;
    let fileBuffer: Buffer | undefined;
    let usedPath: string | undefined;

    try {
      await client.access({
        host: this.printerConfig.ipAddress,
        port: 990,
        user: this.printerConfig.mqttUsername ?? 'bblp',
        password: this.printerConfig.lanAccessCode,
        secure: 'implicit',
        secureOptions: { rejectUnauthorized: false },
      });

      for (const path of candidatePaths) {
        try {
          const chunks: Buffer[] = [];
          const sink = new Writable({
            write(chunk, _enc, cb) {
              chunks.push(chunk);
              cb();
            },
          });
          await client.downloadTo(sink, path);
          fileBuffer = Buffer.concat(chunks);
          usedPath = path;
          break;
        } catch {
          // try the next candidate path
        }
      }
    } catch (err) {
      this.platform.log.warn(`[${this.printerConfig.name}] FTP connection failed: ${(err as Error).message}`);
      return undefined;
    } finally {
      client.close();
    }

    if (!fileBuffer || !usedPath) {
      this.platform.log.warn(
        `[${this.printerConfig.name}] Couldn't find the project file at any of: ${candidatePaths.join(', ')}`,
      );
      return undefined;
    }
    this.platform.log.info(`[${this.printerConfig.name}] Fetched project file from ${usedPath}`);

    try {
      const zip = new AdmZip(fileBuffer);
      const entry =
        zip.getEntry('Metadata/slice_info.config') ??
        zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('slice_info.config'));
      if (!entry) {
        this.platform.log.warn(
          `[${this.printerConfig.name}] No slice_info.config found in the 3MF. Entries: ` +
            zip.getEntries().map((e) => e.entryName).join(', '),
        );
        return undefined;
      }

      const xml = entry.getData().toString('utf-8');
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
      const parsed = parser.parse(xml);

      const plate = parsed?.config?.plate;
      const rawFilaments = plate?.filament;
      const filamentList = Array.isArray(rawFilaments) ? rawFilaments : rawFilaments ? [rawFilaments] : [];

      if (filamentList.length === 0) {
        this.platform.log.warn(
          `[${this.printerConfig.name}] No <filament> entries found in slice_info.config. Raw content: ${xml.slice(0, 500)}`,
        );
        return undefined;
      }

      const results: { type: string; grams: number }[] = [];
      for (const f of filamentList) {
        const type = f['@_type'] as string | undefined;
        const gramsRaw = f['@_used_g'] ?? f['@_usedG'] ?? f['@_weight'];
        const grams = gramsRaw !== undefined ? parseFloat(gramsRaw) : NaN;
        if (!type || Number.isNaN(grams)) {
          this.platform.log.warn(
            `[${this.printerConfig.name}] Couldn't read type/weight from a filament entry - raw: ${JSON.stringify(f)}`,
          );
          continue;
        }
        results.push({ type, grams });
      }

      return results.length > 0 ? results : undefined;
    } catch (err) {
      this.platform.log.warn(
        `[${this.printerConfig.name}] Failed to parse the 3MF project file: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  // Combines same-material entries and prices them via filamentPricesPerKg.
  // A material with no configured price still reports its weight, just with
  // cost: undefined, and is excluded from the total rather than silently
  // treated as free.
  private estimateFilamentCost(
    entries: { type: string; grams: number }[],
  ): { totalCost: number; anyUnpriced: boolean; byMaterial: { type: string; grams: number; cost?: number }[] } {
    const prices = this.printerConfig.filamentPricesPerKg ?? {};
    const byType = new Map<string, number>();
    for (const e of entries) {
      byType.set(e.type, (byType.get(e.type) ?? 0) + e.grams);
    }

    let totalCost = 0;
    let anyUnpriced = false;
    const byMaterial: { type: string; grams: number; cost?: number }[] = [];
    for (const [type, grams] of byType) {
      const pricePerKg = prices[type];
      const cost = pricePerKg !== undefined ? (grams / 1000) * pricePerKg : undefined;
      if (cost !== undefined) {
        totalCost += cost;
      } else {
        anyUnpriced = true;
      }
      byMaterial.push({ type, grams, cost });
    }

    return { totalCost, anyUnpriced, byMaterial };
  }

  private async captureSnapshotFromCameraUi(): Promise<Buffer | undefined> {
    const { cameraUiBaseUrl, cameraUiCameraName } = this.printerConfig;
    if (!cameraUiBaseUrl || !cameraUiCameraName) {
      return undefined;
    }

    const attempt = async (forceRelogin: boolean): Promise<Buffer | undefined> => {
      if (forceRelogin) {
        this.cameraUiToken = undefined;
      }
      const token = await this.getCameraUiToken();
      if (!token) {
        return undefined;
      }
      const url =
        `${cameraUiBaseUrl}/api/cameras/${encodeURIComponent(cameraUiCameraName)}/snapshot` +
        '?buffer=true';
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401 && !forceRelogin) {
        return attempt(true);
      }
      if (!res.ok) {
        this.platform.log.warn(
          `[${this.printerConfig.name}] camera.ui snapshot failed (${res.status}) for camera "${cameraUiCameraName}".`,
        );
        return undefined;
      }
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    };

    try {
      return await attempt(false);
    } catch (err) {
      this.platform.log.warn(`[${this.printerConfig.name}] camera.ui snapshot error: ${(err as Error).message}`);
      return undefined;
    }
  }

  // Uploads a JPEG to GitHub via the Contents API, overwriting one fixed file
  // each time rather than accumulating a new file per notification. Returns a
  // raw.githubusercontent.com URL with a cache-busting timestamp, or undefined
  // on any failure.
  private async uploadSnapshotToGithub(jpeg: Buffer): Promise<string | undefined> {
    const { githubToken, githubOwner, githubRepo } = this.printerConfig;
    if (!githubToken || !githubOwner || !githubRepo) {
      return undefined;
    }
    const path = this.printerConfig.githubSnapshotPath ?? 'images/latest-print.jpg';
    const branch = this.printerConfig.githubBranch ?? 'main';
    const apiUrl = `https://api.github.com/repos/${githubOwner}/${githubRepo}/contents/${path}`;
    const headers = {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'homebridge-bambu-print-status',
    };

    try {
      let sha: string | undefined;
      const existing = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
      if (existing.ok) {
        const body = (await existing.json()) as { sha?: string };
        sha = body.sha;
      }

      const putRes = await fetch(apiUrl, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Update print snapshot (${new Date().toISOString()})`,
          content: jpeg.toString('base64'),
          branch,
          ...(sha ? { sha } : {}),
        }),
      });

      if (!putRes.ok) {
        const errBody = await putRes.text().catch(() => '');
        this.platform.log.warn(
          `[${this.printerConfig.name}] GitHub snapshot upload failed (${putRes.status}): ${errBody}`,
        );
        return undefined;
      }

      return `https://raw.githubusercontent.com/${githubOwner}/${githubRepo}/${branch}/${path}?t=${Date.now()}`;
    } catch (err) {
      this.platform.log.warn(
        `[${this.printerConfig.name}] GitHub snapshot upload error: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  // Wraps sendPingieNotification with an optional live snapshot as the icon.
  // Falls back to a plain text-only notification if capture/upload fails or
  // includeCameraSnapshot isn't enabled - never blocks the underlying alert.
  private async sendPingieNotificationWithSnapshot(title: string, text: string) {
    if (!this.printerConfig.includeCameraSnapshot) {
      return this.sendPingieNotification(title, text);
    }
    const jpeg = await this.captureSnapshotFromCameraUi();
    const snapshotUrl = jpeg ? await this.uploadSnapshotToGithub(jpeg) : undefined;
    return this.sendPingieNotification(title, text, snapshotUrl);
  }

  // Sends the three finish-time notifications in order: combined total,
  // filament breakdown, then electricity alone. Filament data comes from an
  // FTP fetch that takes a few seconds, so this runs as its own async flow
  // rather than blocking the MQTT message handler.
  private async sendFinishedNotifications(elapsedMinutes: number | undefined) {
    const electricityCost = elapsedMinutes !== undefined ? this.estimateCost(elapsedMinutes) : undefined;

    const filamentUsage = await this.fetchFilamentUsage();
    const filamentInfo = filamentUsage ? this.estimateFilamentCost(filamentUsage) : undefined;

    // 1. Combined total.
    const jobName = this.mergedState.subtask_name as string | undefined;
    const combinedParts = jobName
      ? [`Print finished on ${this.printerConfig.name}: "${jobName}".`]
      : [`Print finished on ${this.printerConfig.name}.`];
    if (elapsedMinutes !== undefined) {
      combinedParts.push(`Took ${this.formatDuration(elapsedMinutes)}.`);
    }
    const combinedTotal = (filamentInfo?.totalCost ?? 0) + (electricityCost ?? 0);
    if (filamentInfo || electricityCost !== undefined) {
      combinedParts.push(`Total cost: £${combinedTotal.toFixed(2)}` + (filamentInfo?.anyUnpriced ? ' (some materials unpriced)' : '') + '.');
    }
    await this.sendPingieNotificationWithSnapshot('✅ Print finished', combinedParts.join(' '));

    // 2. Filament breakdown, per material - only sent if we actually got data.
    if (filamentInfo && filamentInfo.byMaterial.length > 0) {
      const lines = filamentInfo.byMaterial.map((m) => {
        const costText = m.cost !== undefined ? `£${m.cost.toFixed(2)}` : 'price not set';
        return `${m.type}: ${m.grams.toFixed(1)}g (${costText})`;
      });
      const filamentTotalText = `Total filament: £${filamentInfo.totalCost.toFixed(2)}` +
        (filamentInfo.anyUnpriced ? ' (excludes unpriced materials).' : '.');
      await this.sendPingieNotificationWithSnapshot(
        '🧵 Filament cost',
        `${this.printerConfig.name}: ${lines.join(', ')}. ${filamentTotalText}`,
      );
    }

    // 3. Electricity alone.
    if (electricityCost !== undefined) {
      await this.sendPingieNotificationWithSnapshot(
        '⚡ Electricity cost',
        `${this.printerConfig.name}: ${elapsedMinutes ? this.formatDuration(elapsedMinutes) + ', ' : ''}` +
          `estimated £${electricityCost.toFixed(2)}.`,
      );
    }
  }

  private async sendPingieNotification(title: string, text: string, overrideIconUrl?: string) {
    const { pingieGroupId, pingieGroupToken, pingieIconUrl, pingieImageUrl } = this.printerConfig;
    if (!pingieGroupId || !pingieGroupToken) {
      return; // notifications not configured - silently skip
    }
    const iconUrl = overrideIconUrl ?? pingieIconUrl;
    try {
      const url =
        `https://notifypush.pingie.com/notify-json/${encodeURIComponent(pingieGroupId)}` +
        `?token=${encodeURIComponent(pingieGroupToken)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          title,
          groupType: 'bambu-print-status',
          ...(iconUrl ? { iconUrl } : {}),
          ...(pingieImageUrl ? { imageUrl: pingieImageUrl } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.platform.log.warn(
          `[${this.printerConfig.name}] Pingie notify failed (${res.status}): ${body}`,
        );
      }
    } catch (err) {
      this.platform.log.warn(
        `[${this.printerConfig.name}] Pingie notify error: ${(err as Error).message}`,
      );
    }
  }

  private formatDuration(totalMinutes: number): string {
    const mins = Math.max(0, Math.round(totalMinutes));
    const hours = Math.floor(mins / 60);
    const remainder = mins % 60;
    return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
  }

  // Returns an estimated cost in pounds, or undefined if wattage/rate aren't configured.
  // This is necessarily an estimate - the printer doesn't report actual power draw over
  // MQTT, so it's average wattage x duration x your rate, not a metered reading.
  private estimateCost(minutes: number): number | undefined {
    const { averagePrintWattage, electricityRatePencePerKwh } = this.printerConfig;
    if (!averagePrintWattage || !electricityRatePencePerKwh) {
      return undefined;
    }
    const kwh = (averagePrintWattage / 1000) * (minutes / 60);
    return (kwh * electricityRatePencePerKwh) / 100;
  }

  private connect() {
    const port = this.printerConfig.mqttPort ?? 8883;
    const username = this.printerConfig.mqttUsername ?? 'bblp';
    const url = `mqtts://${this.printerConfig.ipAddress}:${port}`;

    this.platform.log.info(`[${this.printerConfig.name}] Connecting to ${url}`);

    this.client = mqtt.connect(url, {
      username,
      password: this.printerConfig.lanAccessCode,
      rejectUnauthorized: this.printerConfig.rejectUnauthorized ?? false,
      reconnectPeriod: 0, // handled manually below for clearer logging/state management
      connectTimeout: 10_000,
    });

    this.client.on('connect', () => {
      this.platform.log.info(`[${this.printerConfig.name}] MQTT connected`);
      this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, true);

      this.client!.subscribe(`device/${this.printerConfig.serialNumber}/report`, (err) => {
        if (err) {
          this.platform.log.error(`[${this.printerConfig.name}] Subscribe failed: ${err.message}`);
        }
      });

      this.requestFullState();
      this.startRefreshTimer();
    });

    this.client.on('message', (_topic, payload) => this.handleMessage(payload));

    this.client.on('error', (err) => {
      this.platform.log.warn(`[${this.printerConfig.name}] MQTT error: ${err.message}`);
    });

    this.client.on('close', () => {
      this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, false);
      this.stopRefreshTimer();
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }
    const delay = (this.printerConfig.reconnectDelaySeconds ?? 10) * 1000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.platform.log.info(`[${this.printerConfig.name}] Reconnecting...`);
      this.connect();
    }, delay);
  }

  private startRefreshTimer() {
    this.stopRefreshTimer();
    const seconds = this.printerConfig.refreshIntervalSeconds ?? 60;
    this.refreshTimer = setInterval(() => this.requestFullState(), seconds * 1000);
  }

  private stopRefreshTimer() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  // Ask the printer to push its full current state rather than just diffs.
  private requestFullState() {
    if (!this.client || !this.client.connected) {
      return;
    }
    const payload = JSON.stringify({
      pushing: { sequence_id: '0', command: 'pushall' },
    });
    this.client.publish(`device/${this.printerConfig.serialNumber}/request`, payload);
  }

  private handleMessage(payload: Buffer) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload.toString());
    } catch {
      return; // ignore malformed/partial frames
    }

    const printBlock = parsed?.print as Record<string, unknown> | undefined;
    if (!printBlock) {
      return;
    }

    this.mergedState = { ...this.mergedState, ...printBlock };

    const lightsReport = this.mergedState.lights_report as
      | Array<{ node?: string; mode?: string }>
      | undefined;
    if (Array.isArray(lightsReport)) {
      const chamberLight = lightsReport.find((l) => l.node === 'chamber_light');
      if (chamberLight?.mode) {
        const reportedOn = chamberLight.mode === 'on';
        if (reportedOn !== this.chamberLightOn) {
          this.chamberLightOn = reportedOn;
          this.lightService.updateCharacteristic(this.platform.Characteristic.On, reportedOn);
        }
      }
    }

    const gcodeState = this.mergedState.gcode_state as string | undefined;
    if (!gcodeState) {
      return;
    }

    // Keep the Pause switch in sync with reality, however the state changed
    // (our own command, the touchscreen, or the Bambu app).
    const pausedNow = gcodeState === 'PAUSE';
    if (pausedNow !== this.currentlyPaused) {
      this.currentlyPaused = pausedNow;
      this.pauseService.updateCharacteristic(this.platform.Characteristic.On, pausedNow);
    }

    // Fault/error alert - a nonzero print_error or any active hms entries means
    // something needs attention.
    const printError = this.mergedState.print_error as number | undefined;
    const hms = this.mergedState.hms as Array<unknown> | undefined;
    const faultNow = Boolean(printError && printError !== 0) || Boolean(hms && hms.length > 0);
    if (faultNow !== this.faultPresent) {
      this.faultPresent = faultNow;
      const description = printError ? this.describeError(printError) : undefined;
      this.platform.log.info(
        `[${this.printerConfig.name}] Fault ${faultNow ? 'DETECTED' : 'CLEARED'} ` +
          `(print_error=${printError ?? 'none'}${description ? ` - ${description}` : ''}, ` +
          `hms_entries=${hms?.length ?? 0})`,
      );
      this.faultService.updateCharacteristic(
        this.platform.Characteristic.ContactSensorState,
        faultNow
          ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );
      if (faultNow) {
        const codeSuffix = printError ? ` (${this.hexKeyForCode(printError)})` : '';
        const body = description
          ? `${this.printerConfig.name}: ${description}${codeSuffix}`
          : `${this.printerConfig.name} reported a fault (print_error=${printError ?? 'unknown'}, ` +
            `${hms?.length ?? 0} active HMS entries). Check the printer.`;
        void this.sendPingieNotificationWithSnapshot('🚨 Printer fault', body);
      }
    }

    // Filament run-out - trips for print_error codes that the bundled community
    // mapping identifies as run-out variants (any feed path/AMS slot), or any
    // extra codes you've added yourself. Any other pause just gets logged so
    // you can extend the list if your firmware uses a code not covered here.
    const runoutCodes = this.printerConfig.filamentRunoutErrorCodes ?? KNOWN_FILAMENT_RUNOUT_CODES;
    const printErrorHexKey = printError ? this.hexKeyForCode(printError) : undefined;
    const filamentNow = Boolean(printErrorHexKey && runoutCodes.includes(printErrorHexKey));
    if (filamentNow !== this.filamentOut) {
      this.filamentOut = filamentNow;
      this.filamentService.updateCharacteristic(
        this.platform.Characteristic.ContactSensorState,
        filamentNow
          ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );
      if (filamentNow) {
        const description = printError ? this.describeError(printError) : undefined;
        void this.sendPingieNotificationWithSnapshot(
          '🧵⚠️ Filament run-out',
          description
            ? `${this.printerConfig.name}: ${description}`
            : `${this.printerConfig.name} has run out of filament (print_error=${printError}). ` +
              'Reload filament and resume from the touchscreen or app.',
        );
      }
    }
    if (gcodeState === 'PAUSE' && printErrorHexKey && !runoutCodes.includes(printErrorHexKey)) {
      const description = printError ? this.describeError(printError) : undefined;
      this.platform.log.info(
        `[${this.printerConfig.name}] Paused with print_error=${printError} (${printErrorHexKey})` +
          `${description ? ` - ${description}` : ''}. If this was a filament run-out not already ` +
          'covered by the default list, add "' +
          printErrorHexKey +
          '" to filamentRunoutErrorCodes in the config to have the Filament sensor track it.',
      );
    }

    // Print-started notification - only a real start, not a resume from PAUSE.
    if (gcodeState === 'RUNNING' && this.previousGcodeState !== 'RUNNING' && this.previousGcodeState !== 'PAUSE') {
      this.printStartTimestamp = Date.now();
      this.lastNotifiedProgressBucket = -1;
      // Clear any stale estimate left over from a previous print so the delayed
      // notification below can't accidentally use last print's number.
      delete this.mergedState.mc_remaining_time;
      this.printEstimatedTotalMinutes = undefined;

      this.platform.log.info(`[${this.printerConfig.name}] Print started.`);
      this.startedSwitchService.updateCharacteristic(
        this.platform.Characteristic.ProgrammableSwitchEvent,
        this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
      );

      // Delay the Pingie push (not the HomeKit switch above, which fires
      // instantly) so mc_remaining_time has a real chance to populate with
      // this print's own estimate first, rather than reporting "no estimate
      // yet" immediately.
      if (this.startNotificationTimer) {
        clearTimeout(this.startNotificationTimer);
      }
      const delaySeconds = this.printerConfig.startNotificationDelaySeconds ?? 30;
      this.startNotificationTimer = setTimeout(() => {
        this.startNotificationTimer = undefined;
        const remaining = this.mergedState.mc_remaining_time as number | undefined;
        this.printEstimatedTotalMinutes = typeof remaining === 'number' && remaining > 0 ? remaining : undefined;
        const jobName = this.mergedState.subtask_name as string | undefined;

        const parts = jobName
          ? [`Print started on ${this.printerConfig.name}: "${jobName}".`]
          : [`Print started on ${this.printerConfig.name}.`];
        if (this.printEstimatedTotalMinutes) {
          parts.push(`Estimated time: ${this.formatDuration(this.printEstimatedTotalMinutes)}.`);
          const cost = this.estimateCost(this.printEstimatedTotalMinutes);
          if (cost !== undefined) {
            parts.push(`Estimated cost: £${cost.toFixed(2)}.`);
          }
        } else {
          parts.push("No time estimate available from the printer yet - check the app for progress.");
        }
        void this.sendPingieNotificationWithSnapshot('🖨️ Print started', parts.join(' '));
      }, delaySeconds * 1000);
    }

    // Print-finished notification - fire once on the transition into FINISH,
    // not on every subsequent message while it stays FINISH.
    if (gcodeState === 'FINISH' && this.previousGcodeState !== 'FINISH') {
      const elapsedMinutes = this.printStartTimestamp
        ? (Date.now() - this.printStartTimestamp) / 60_000
        : undefined;

      this.platform.log.info(
        `[${this.printerConfig.name}] Print finished` +
          (elapsedMinutes ? ` - took ${this.formatDuration(elapsedMinutes)}` : ''),
      );
      this.finishedSwitchService.updateCharacteristic(
        this.platform.Characteristic.ProgrammableSwitchEvent,
        this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
      );

      void this.sendFinishedNotifications(elapsedMinutes);

      this.printStartTimestamp = undefined;
      this.printEstimatedTotalMinutes = undefined;
    }
    this.previousGcodeState = gcodeState;

    const occupied = this.activeStates.includes(gcodeState);
    if (occupied !== this.currentlyOccupied) {
      this.currentlyOccupied = occupied;
      this.platform.log.info(
        `[${this.printerConfig.name}] gcode_state=${gcodeState} -> occupancy ${
          occupied ? 'DETECTED' : 'CLEAR'
        }`,
      );
      this.service.updateCharacteristic(
        this.platform.Characteristic.OccupancyDetected,
        occupied
          ? this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
          : this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
      );
      this.progressService.updateCharacteristic(
        this.platform.Characteristic.Active,
        occupied
          ? this.platform.Characteristic.Active.ACTIVE
          : this.platform.Characteristic.Active.INACTIVE,
      );
    }

    // Reconcile speed level against the printer's own report if it's present
    // (moderate confidence in this exact field name, not independently
    // verified - if it never fires, the control still works fine off our own
    // optimistic tracking, it just won't self-correct from external changes).
    const spdLvl = this.mergedState.spd_lvl as number | undefined;
    if (typeof spdLvl === 'number' && [1, 2, 3, 4].includes(spdLvl) && spdLvl !== this.currentSpeedLevel) {
      this.currentSpeedLevel = spdLvl;
      this.speedService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, spdLvl * 25);
    }

    const mcPercent = this.mergedState.mc_percent as number | undefined;
    if (typeof mcPercent === 'number') {
      const clamped = Math.max(0, Math.min(100, Math.round(mcPercent)));
      if (clamped !== this.printProgressPercent) {
        this.printProgressPercent = clamped;
        this.progressService.updateCharacteristic(
          this.platform.Characteristic.RotationSpeed,
          clamped,
        );
      }

      const interval = this.printerConfig.progressNotificationIntervalPercent ?? 5;
      if (interval > 0 && occupied) {
        const bucket = Math.floor(clamped / interval) * interval;
        if (bucket > this.lastNotifiedProgressBucket && bucket > 0) {
          this.lastNotifiedProgressBucket = bucket;
          const remaining = this.mergedState.mc_remaining_time as number | undefined;
          const remainingText =
            typeof remaining === 'number' && remaining >= 0
              ? `${this.formatDuration(remaining)} remaining`
              : 'time remaining not available yet';
          void this.sendPingieNotificationWithSnapshot(
            '🖨️ Print progress',
            `${this.printerConfig.name}: ${bucket}% complete - ${remainingText}.`,
          );
        }
      }
    }
  }

  public shutdown() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.startNotificationTimer) {
      clearTimeout(this.startNotificationTimer);
    }
    this.stopRefreshTimer();
    this.client?.end(true);
  }
}
