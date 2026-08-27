import { Service, PlatformAccessory } from 'homebridge';
import * as mqtt from 'mqtt';
import { Client as FtpClient } from 'basic-ftp';
import { Writable } from 'stream';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ping = require('ping') as { promise: { probe: (host: string) => Promise<{ alive: boolean }> } };
import { BambuPrintStatusPlatform } from './platform';
import { BAMBU_ERROR_CODES, KNOWN_FILAMENT_RUNOUT_CODES } from './bambuErrorCodes';
import { BAMBU_HMS_CODES } from './bambuHmsCodes';

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
  reconnectMaxDelaySeconds?: number;
  // Opt-in, off by default. Instead of always attempting a real MQTT/TLS
  // handshake, pings the printer's IP first - only attempts the actual
  // connection if the ping succeeds, and skips it entirely (checking again
  // next cycle) if the printer isn't even reachable at the network layer.
  // Helps most when the printer is genuinely off-network (confirmed real
  // failure mode); may help less for an app-layer hang that still responds
  // to ping. No downside either way.
  enableNetworkPresenceCheck?: boolean;
  presenceCheckIntervalSeconds?: number;
  // Sends a "check the printer" Pingie push after this many consecutive
  // failed reconnect attempts, then again every that-many attempts while it
  // stays down, so a lost connection doesn't just go silent. Set to 0 to
  // disable. Defaults to 5.
  mqttReconnectAlertThreshold?: number;

  // Live Activities (Pingie's Lock Screen tile feature) - opt-in, off by
  // default. Replaces the Started/Progress/Finished push notification stack
  // with one persistent, updating tile instead. IMPORTANT: this is a
  // per-DEVICE feature, not per-group - needs a separate device ID/token
  // from the Notify! app, distinct from pingieGroupId/pingieGroupToken.
  useLiveActivity?: boolean;
  pingieDeviceId?: string;
  pingieDeviceToken?: string;
  liveActivitySymbol?: string; // SF Symbol name, e.g. "printer.fill"
  liveActivityTint?: string; // "#RRGGBB"
  liveActivityKeepForSeconds?: number; // how long the finished tile lingers
  // Diagnostic-only, off by default to keep MQTT traffic minimal. Subscribes
  // to the /request topic to sniff commands sent by other clients (Bambu
  // Studio's native buttons) - only useful while actively hunting for
  // something like the AMS drying ams_id. Turn off again once found.
  enableRequestTopicSniffing?: boolean;
  // gcode_state values that should be treated as "occupied" (printer actively in use).
  activeStates?: string[];
  // print_error codes (as reported by the printer, e.g. "83935248") confirmed to mean
  // "out of filament" on your printer/firmware. Leave empty until you've triggered a
  // real runout and read the logged code - see README.
  filamentRunoutErrorCodes?: string[];

  // Pingie "Notify!" group push notifications - both are required to enable notifications.
  // Get these from the Notify! app (Group settings), or GET /link on push.getnotifyapp.com
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
  // Print preview thumbnail - the slicer-rendered plate image embedded in the
  // sliced 3MF (the same one the touchscreen shows browsing files), extracted
  // via the FTP connection already used for filament weight, not the camera.
  // Preferred over includeCameraSnapshot when both are enabled. Not usable
  // with Live Activities - that API only supports SF Symbols, no custom image.
  includePrintPreviewImage?: boolean;
  githubPreviewImagePath?: string;
  githubBranch?: string;

  // Price per kg by material type (e.g. {"PLA": 18.99, "PETG": 22.99}), used
  // to cost out the filament actually used in a finished print, read from the
  // sliced 3MF file's own metadata via FTP rather than AMS remaining-%
  // tracking (which only works for genuine Bambu RFID spools). A material not
  // in this map still shows its weight, just without a cost figure.
  filamentPrices?: Array<{ material: string; pricePerKg: number }>;

  // Which progress-style accessory(ies) to expose: the Progress fan
  // (0-100% slider), the Countdown light sensor (lux value encodes
  // MM.SS - minutes as the whole number, seconds as the decimal), or both.
  // Defaults to "both" to preserve existing behaviour for anyone already
  // using this.
  progressDisplayMode?: 'fan' | 'countdown' | 'both';

  // Optional temperature sensors (bed/nozzle/chamber) - off by default so a
  // public plugin doesn't clutter Home app with tiles most people won't want.
  showTemperatureSensors?: boolean;

  // AMS 2 Pro remote drying control - opt-in, the switch/logic only gets
  // created if amsId is set. The drying MQTT command is reverse-engineered
  // (moderate-good confidence, confirmed by two independent sources), but
  // ams_id doesn't follow the simple 0-3 unit numbering used elsewhere in the
  // protocol - the one confirmed working example used 131, unexplained. No
  // auto-detection attempted; this needs to be found by experimentation.
  amsId?: number;
  // Which index into the ams.ams[] array to read humidity from (separate from
  // amsId above, which is only for the drying command itself). Defaults to 0
  // (the first/only AMS unit).
  amsHumidityUnitIndex?: number;
  // Thresholds are on whatever scale the raw humidity field turns out to use -
  // NOT confirmed to be a true 0-100% reading. The one AMS 2 Pro-specific
  // community report found is an unresolved open issue asking for exactly
  // this. Defaults assume a real percentage; if logs show a small 1-5 style
  // index instead, these need adjusting to match.
  amsDryStartThreshold?: number;
  amsDryStopThreshold?: number;
  amsDryTargetTemp?: number; // must be >=45 per the reverse-engineered command, enforced
  amsDryDurationHours?: number; // hardware-level failsafe cutoff, independent of our own stop command
}

const DEFAULT_ACTIVE_STATES = ['RUNNING', 'PREPARE', 'PAUSE', 'SLICING'];

export class BambuPrinterAccessory {
  private readonly service: Service;
  private readonly lightService: Service;
  private progressService?: Service;
  private readonly speedService: Service;
  private countdownService?: Service;
  private amsAutoDryService?: Service;
  private bedTempService?: Service;
  private nozzleTempService?: Service;
  private chamberTempService?: Service;
  private readonly pauseService: Service;
  private readonly startedSwitchService: Service;
  private readonly finishedSwitchService: Service;
  private readonly faultService: Service;
  private readonly filamentService: Service;
  private readonly doorService: Service;
  private client?: mqtt.MqttClient;
  private chamberLightOn = false;
  private currentlyPaused = false;
  private bedHeatingActive = false;
  private nozzleHeatingActive = false;
  private amsAutoDryEnabled = false; // defaults off on every restart - deliberate safety choice for a heater
  private amsDryingActive = false;
  private loggedHumidityScaleHint = false;
  private faultPresent = false;
  private firstLayerCheckActive = false;
  private filamentOut = false;
  private doorOpen = false;
  private previousGcodeState?: string;
  private printProgressPercent = 0;
  private countdownSecondsRemaining = 0;
  private currentPrintThumbnailUrl?: string;
  private countdownTicker?: ReturnType<typeof setInterval>;
  // 1=Silent, 2=Standard, 3=Sport, 4=Ludicrous. Tracked optimistically from
  // our own commands; also reconciled against the printer's own spd_lvl
  // field when present in the report (moderate, not fully verified confidence
  // in that exact field name - falls back to optimistic tracking if absent).
  private currentSpeedLevel = 2;
  private speedCommandCooldownUntil = 0;
  private speedCommandCorrectionTimer?: ReturnType<typeof setTimeout>;
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
  private consecutiveReconnectFailures = 0;
  private loggedPingUnavailableWarning = false;
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

    // One-time cleanup: earlier plugin versions created some services
    // (Fanv2, ContactSensor, StatelessProgrammableSwitch) without explicit
    // subtypes, before this version needed them to distinguish multiple
    // services of the same type on one accessory (e.g. Progress vs Speed
    // fans). Homebridge identifies cached services by subtype, so adding a
    // subtype to a previously-subtype-less service abandons the old one
    // rather than renaming it - this removes those orphaned leftovers so
    // upgrading doesn't leave duplicate/dead tiles behind in the Home app.
    const typesToDeduplicate = [
      this.platform.Service.Fanv2.UUID,
      this.platform.Service.ContactSensor.UUID,
      this.platform.Service.StatelessProgrammableSwitch.UUID,
      this.platform.Service.Switch.UUID,
    ];
    for (const existing of [...this.accessory.services]) {
      if (typesToDeduplicate.includes(existing.UUID) && !existing.subtype) {
        this.platform.log.info(
          `[${printerConfig.name}] Removing orphaned pre-upgrade service: ${existing.displayName}`,
        );
        this.accessory.removeService(existing);
      }
    }

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
    // Only created if progressDisplayMode includes "fan" (default "both").
    const progressMode = printerConfig.progressDisplayMode ?? 'both';
    if (progressMode === 'fan' || progressMode === 'both') {
      this.progressService =
        this.accessory.getServiceById(this.platform.Service.Fanv2, 'progress') ||
        this.accessory.addService(this.platform.Service.Fanv2, `${printerConfig.name} Progress`, 'progress');
      const progressService = this.progressService;
      progressService.setCharacteristic(
        this.platform.Characteristic.Name,
        `${printerConfig.name} Progress`,
      );
      progressService
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
              progressService.updateCharacteristic(
                this.platform.Characteristic.Active,
                this.currentlyOccupied
                  ? this.platform.Characteristic.Active.ACTIVE
                  : this.platform.Characteristic.Active.INACTIVE,
              ),
            0,
          );
        });
      progressService
        .getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onGet(() => this.printProgressPercent)
        .onSet(() => {
          // Read-only: revert any manual drag back to the real percentage.
          setTimeout(
            () =>
              progressService.updateCharacteristic(
                this.platform.Characteristic.RotationSpeed,
                this.printProgressPercent,
              ),
            0,
          );
        });
    } else {
      // Mode is "valve" only - remove any previously-created Progress fan so
      // switching modes doesn't leave an orphaned tile behind.
      const existing = this.accessory.getServiceById(this.platform.Service.Fanv2, 'progress');
      if (existing) {
        this.accessory.removeService(existing);
      }
    }

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
      .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
      .onGet(() => this.currentSpeedLevel * 25)
      .onSet((value) => this.setPrintSpeed(Math.round((value as number) / 25)));

    // Countdown timer - LightSensor's CurrentAmbientLightLevel repurposed as
    // MM.SS: whole-number part is minutes remaining, decimal part is seconds
    // (e.g. 45.30 = 45m 30s). Ticks locally once per second between real
    // mc_remaining_time updates (which only have minute precision) so it
    // counts down smoothly rather than jumping once a minute - resynced to
    // the real value whenever a fresh one arrives, so it can't drift far.
    // Only created if progressDisplayMode includes "countdown" (default "both").
    if (progressMode === 'countdown' || progressMode === 'both') {
      this.countdownService =
        this.accessory.getServiceById(this.platform.Service.LightSensor, 'countdown') ||
        this.accessory.addService(
          this.platform.Service.LightSensor,
          `${printerConfig.name} Countdown`,
          'countdown',
        );
      const countdownService = this.countdownService;
      countdownService.setCharacteristic(this.platform.Characteristic.Name, `${printerConfig.name} Countdown`);
      countdownService
        .getCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel)
        .setProps({ minValue: 0, maxValue: 2000, minStep: 0.01 })
        .onGet(() => this.countdownLightSensorValue());
    } else {
      // Mode doesn't include "countdown" - remove any previously-created
      // countdown light sensor so switching modes doesn't leave an orphan.
      const existing = this.accessory.getServiceById(this.platform.Service.LightSensor, 'countdown');
      if (existing) {
        this.accessory.removeService(existing);
      }
      this.stopCountdownTicker();
    }

    // Pause/Resume - a genuine two-state Switch (unlike Stop, this is safely
    // reversible): On while the printer is paused, Off while running. Reflects
    // real gcode_state so it stays in sync if paused/resumed from the touchscreen.
    this.pauseService =
      this.accessory.getServiceById(this.platform.Service.Switch, 'pause') ||
      this.accessory.addService(this.platform.Service.Switch, `${printerConfig.name} Pause`, 'pause');
    this.pauseService.setCharacteristic(this.platform.Characteristic.Name, `${printerConfig.name} Pause`);
    this.pauseService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.currentlyPaused)
      .onSet((value) => this.setPauseState(value as boolean));

    // AMS 2 Pro auto-dry - opt-in, only created if amsId is configured. This
    // is a Switch that enables/disables the automatic threshold-based drying
    // logic (handled in handleMessage), NOT a direct dryer toggle - and
    // deliberately not a humidity sensor tile, per your request. Defaults to
    // Off on every Homebridge restart rather than persisting state, since
    // this controls a physical heater and silently resuming that
    // unattended after a restart isn't a reasonable default.
    if (printerConfig.amsId !== undefined) {
      this.amsAutoDryService =
        this.accessory.getServiceById(this.platform.Service.Switch, 'ams-auto-dry') ||
        this.accessory.addService(this.platform.Service.Switch, `${printerConfig.name} AMS Auto-Dry`, 'ams-auto-dry');
      this.amsAutoDryService.setCharacteristic(
        this.platform.Characteristic.Name,
        `${printerConfig.name} AMS Auto-Dry`,
      );
      this.amsAutoDryService
        .getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.amsAutoDryEnabled)
        .onSet((value) => this.setAmsAutoDryEnabled(value as boolean));
    }

    // Optional temperature sensors - off by default, only created if
    // showTemperatureSensors is explicitly enabled. HomeKit's
    // CurrentTemperature characteristic defaults to a 0-100°C range, which
    // would clip real nozzle readings (easily 220°C+) - extended explicitly
    // for bed and nozzle below.
    if (printerConfig.showTemperatureSensors) {
      this.bedTempService =
        this.accessory.getServiceById(this.platform.Service.TemperatureSensor, 'bed-temp') ||
        this.accessory.addService(
          this.platform.Service.TemperatureSensor,
          `${printerConfig.name} Bed Temp`,
          'bed-temp',
        );
      this.bedTempService.setCharacteristic(this.platform.Characteristic.Name, `${printerConfig.name} Bed Temp`);
      this.bedTempService
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .setProps({ minValue: -20, maxValue: 150 });

      this.nozzleTempService =
        this.accessory.getServiceById(this.platform.Service.TemperatureSensor, 'nozzle-temp') ||
        this.accessory.addService(
          this.platform.Service.TemperatureSensor,
          `${printerConfig.name} Nozzle Temp`,
          'nozzle-temp',
        );
      this.nozzleTempService.setCharacteristic(
        this.platform.Characteristic.Name,
        `${printerConfig.name} Nozzle Temp`,
      );
      this.nozzleTempService
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .setProps({ minValue: -20, maxValue: 350 });

      this.chamberTempService =
        this.accessory.getServiceById(this.platform.Service.TemperatureSensor, 'chamber-temp') ||
        this.accessory.addService(
          this.platform.Service.TemperatureSensor,
          `${printerConfig.name} Chamber Temp`,
          'chamber-temp',
        );
      this.chamberTempService.setCharacteristic(
        this.platform.Characteristic.Name,
        `${printerConfig.name} Chamber Temp`,
      );
      this.chamberTempService
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .setProps({ minValue: -20, maxValue: 100 });
    }

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

    // Door sensor - uses STANDARD contact sensor semantics (unlike Fault/
    // Filament above, which are deliberately inverted for alarm-style
    // automation triggering): DETECTED = closed, NOT_DETECTED = open, exactly
    // matching every other HomeKit door/window sensor, so existing automation
    // patterns work as expected. Verified against real captured MQTT data:
    // home_flag bit 0x00800000 set = open, clear = closed. This bit was
    // confirmed broken on X1C firmware 01.08.02.00 (Jan 2025) and confirmed
    // working on 01.10.00.00 (Oct 2025) - almost certainly fine on current
    // firmware, but worth a quick physical door-open test to be sure.
    this.doorService =
      this.accessory.getServiceById(this.platform.Service.ContactSensor, 'door') ||
      this.accessory.addService(this.platform.Service.ContactSensor, `${printerConfig.name} Door`, 'door');
    this.doorService.setCharacteristic(this.platform.Characteristic.Name, `${printerConfig.name} Door`);
    this.doorService
      .getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(() =>
        this.doorOpen
          ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );

    this.connect();
  }

  // The "Inspecting first layer" HMS code is informational - Bambu's AI camera
  // monitoring reports this during essentially every normal print that has
  // first-layer inspection enabled. It's not a fault and shouldn't trip the
  // Fault sensor/alarm notification - handled as its own separate, non-alarming
  // notification instead.
  private static readonly FIRST_LAYER_CHECK_HMS_CODE = '0C00-0300-0003-000B';

  // Decodes an hms entry's attr/code fields into Bambu's own 4-part display
  // code format - confirmed correct against a real touchscreen error
  // (0500-0500-0001-0007). Field names "attr"/"code" on the hms entry itself
  // are moderate-confidence, not independently verified against a live
  // payload - logs the raw entry if they're missing so this can be corrected.
  private decodeHmsCode(entry: { attr?: number; code?: number }): string | undefined {
    if (typeof entry.attr !== 'number' || typeof entry.code !== 'number') {
      this.platform.log.warn(
        `[${this.printerConfig.name}] HMS entry missing attr/code fields - raw: ${JSON.stringify(entry)}`,
      );
      return undefined;
    }
    const hexAttr = (entry.attr >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const hexCode = (entry.code >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const combined = hexAttr + hexCode;
    return `${combined.slice(0, 4)}-${combined.slice(4, 8)}-${combined.slice(8, 12)}-${combined.slice(12, 16)}`;
  }

  // Formats an hms entry into a short human-readable description, falling
  // back to the raw display code if nothing matches in the bundled table.
  private formatHmsEntry(entry: { attr?: number; code?: number }): string | undefined {
    const displayCode = this.decodeHmsCode(entry);
    if (!displayCode) {
      return undefined;
    }
    const description = BAMBU_HMS_CODES[displayCode];
    return description ?? displayCode;
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
    this.notifySpeedChange(level);

    // Debounce: the printer's own status reports can briefly lag right after
    // we send a command, still reflecting the old value for a moment before
    // catching up. Without this, that lag gets misread as a genuine external
    // change and fires its own (wrong) notification, which then "corrects"
    // itself again once the real value arrives - the "100 -> 50 -> 100"
    // pattern. Suppress reconciliation notifications for a cooldown window,
    // then do exactly one check: if the printer settled on something other
    // than what we asked for, that's a real correction worth notifying about.
    const cooldownMs = 5000;
    this.speedCommandCooldownUntil = Date.now() + cooldownMs;
    if (this.speedCommandCorrectionTimer) {
      clearTimeout(this.speedCommandCorrectionTimer);
    }
    this.speedCommandCorrectionTimer = setTimeout(() => {
      this.speedCommandCorrectionTimer = undefined;
      if (this.currentSpeedLevel !== level) {
        this.platform.log.info(
          `[${this.printerConfig.name}] Speed settled at ${names[this.currentSpeedLevel]}, ` +
            `not the requested ${names[level]} - sending correction.`,
        );
        this.speedService.updateCharacteristic(
          this.platform.Characteristic.RotationSpeed,
          this.currentSpeedLevel * 25,
        );
        void this.sendPingieNotificationWithSnapshot(
          '🚀 Speed changed',
          `${this.printerConfig.name}: actually now ${names[this.currentSpeedLevel]} ` +
            `(${this.currentSpeedLevel * 25}%) - requested ${names[level]} didn't stick.`,
        );
      }
    }, cooldownMs);
  }

  private notifySpeedChange(level: number) {
    const names = ['', 'Silent', 'Standard', 'Sport', 'Ludicrous'];
    void this.sendPingieNotificationWithSnapshot(
      '🚀 Speed changed',
      `${this.printerConfig.name}: now ${names[level]} (${level * 25}%).`,
    );
  }

  // Sends the reverse-engineered AMS drying command. temp/cooling_temp are
  // clamped to a minimum of 45 since the community report found the command
  // silently no-ops below that. ams_id must be manually configured - it
  // doesn't follow the simple 0-3 numbering used elsewhere in the protocol.
  private sendAmsDryCommand(start: boolean) {
    if (!this.client || !this.client.connected) {
      this.platform.log.warn(`[${this.printerConfig.name}] Can't control AMS drying - not connected.`);
      return;
    }
    const amsId = this.printerConfig.amsId;
    if (amsId === undefined) {
      return; // shouldn't happen - service is only created when amsId is set
    }
    const temp = Math.max(45, this.printerConfig.amsDryTargetTemp ?? 45);
    const payload = JSON.stringify({
      print: {
        sequence_id: '0',
        ams_id: amsId,
        command: 'ams_filament_drying',
        mode: start ? 1 : 0,
        temp: start ? temp : 0,
        cooling_temp: start ? temp : 40,
        duration: start ? (this.printerConfig.amsDryDurationHours ?? 8) : 0,
        humidity: 0,
        rotate_tray: false,
      },
    });
    this.client.publish(`device/${this.printerConfig.serialNumber}/request`, payload);
    this.platform.log.info(`[${this.printerConfig.name}] AMS drying -> ${start ? 'START' : 'STOP'} (ams_id=${amsId})`);
  }

  private setAmsAutoDryEnabled(enabled: boolean) {
    this.amsAutoDryEnabled = enabled;
    this.platform.log.info(`[${this.printerConfig.name}] AMS Auto-Dry ${enabled ? 'ENABLED' : 'DISABLED'}`);
    void this.sendPingieNotificationWithSnapshot(
      enabled ? '🌬️ AMS Auto-Dry enabled' : '🌬️ AMS Auto-Dry disabled',
      `${this.printerConfig.name}: automatic drying is now ${enabled ? 'on' : 'off'}.`,
    );

    // Turning the feature off also stops any drying it started, rather than
    // leaving a heater running with nothing left to turn it off later.
    if (!enabled && this.amsDryingActive) {
      this.sendAmsDryCommand(false);
      this.amsDryingActive = false;
      void this.sendPingieNotificationWithSnapshot(
        '🌬️ AMS drying stopped',
        `${this.printerConfig.name}: stopped because Auto-Dry was turned off.`,
      );
    }
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
  // Shared FTP fetch of the current project's sliced .3mf file - used by both
  // filament weight parsing and print preview thumbnail extraction, so
  // there's one connection-handling path rather than two copies of it.
  private async downloadProjectFile(): Promise<{ buffer: Buffer; path: string } | undefined> {
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
    return { buffer: fileBuffer, path: usedPath };
  }

  private async fetchFilamentUsage(): Promise<{ type: string; grams: number }[] | undefined> {
    const downloaded = await this.downloadProjectFile();
    if (!downloaded) {
      return undefined;
    }
    const { buffer: fileBuffer } = downloaded;

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

  // Combines same-material entries and prices them via filamentPrices (an
  // array of {material, pricePerKg} - not a plain object map, specifically so
  // Homebridge UI's auto-generated form can render it as a normal editable
  // list with an Add button, rather than needing the raw JSON editor).
  // A material with no configured price still reports its weight, just with
  // cost: undefined, and is excluded from the total rather than silently
  // treated as free.
  private estimateFilamentCost(
    entries: { type: string; grams: number }[],
  ): { totalCost: number; anyUnpriced: boolean; byMaterial: { type: string; grams: number; cost?: number }[] } {
    const priceList = this.printerConfig.filamentPrices ?? [];
    const prices = new Map(priceList.map((p) => [p.material, p.pricePerKg]));
    const byType = new Map<string, number>();
    for (const e of entries) {
      byType.set(e.type, (byType.get(e.type) ?? 0) + e.grams);
    }

    let totalCost = 0;
    let anyUnpriced = false;
    const byMaterial: { type: string; grams: number; cost?: number }[] = [];
    for (const [type, grams] of byType) {
      const pricePerKg = prices.get(type);
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
  private async uploadImageToGithub(image: Buffer, path: string): Promise<string | undefined> {
    const { githubToken, githubOwner, githubRepo } = this.printerConfig;
    if (!githubToken || !githubOwner || !githubRepo) {
      return undefined;
    }
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
          message: `Update ${path} (${new Date().toISOString()})`,
          content: image.toString('base64'),
          branch,
          ...(sha ? { sha } : {}),
        }),
      });

      if (!putRes.ok) {
        const errBody = await putRes.text().catch(() => '');
        this.platform.log.warn(
          `[${this.printerConfig.name}] GitHub image upload failed (${putRes.status}) for ${path}: ${errBody}`,
        );
        return undefined;
      }

      return `https://raw.githubusercontent.com/${githubOwner}/${githubRepo}/${branch}/${path}?t=${Date.now()}`;
    } catch (err) {
      this.platform.log.warn(
        `[${this.printerConfig.name}] GitHub image upload error: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  // Wraps sendPingieNotification with an image as the icon, preferring a
  // cached print-preview render (extracted from the sliced 3MF, if enabled
  // and already fetched for this print) over a live camera.ui snapshot.
  // Falls back to a plain text-only notification if neither is available -
  // never blocks the underlying alert.
  private async sendPingieNotificationWithSnapshot(title: string, text: string) {
    if (this.printerConfig.includePrintPreviewImage && this.currentPrintThumbnailUrl) {
      return this.sendPingieNotification(title, text, this.currentPrintThumbnailUrl);
    }
    if (!this.printerConfig.includeCameraSnapshot) {
      return this.sendPingieNotification(title, text);
    }
    const jpeg = await this.captureSnapshotFromCameraUi();
    const snapshotUrl = jpeg
      ? await this.uploadImageToGithub(jpeg, this.printerConfig.githubSnapshotPath ?? 'images/latest-print.jpg')
      : undefined;
    return this.sendPingieNotification(title, text, snapshotUrl);
  }

  // Extracts the slicer-rendered plate preview (the same thumbnail the
  // touchscreen shows when browsing files) from the sliced 3MF and uploads it
  // to GitHub, caching the resulting URL for reuse across every notification
  // for this print rather than re-fetching over FTP each time. Called once
  // per print, fire-and-forget - a failure here never blocks notifications,
  // they just fall back to the camera snapshot (if enabled) or plain text.
  private async fetchAndCachePrintThumbnail() {
    if (!this.printerConfig.includePrintPreviewImage) {
      return;
    }
    const downloaded = await this.downloadProjectFile();
    if (!downloaded) {
      return;
    }
    try {
      const zip = new AdmZip(downloaded.buffer);
      const entries = zip.getEntries();
      const entry =
        entries.find((e) => /^Metadata\/plate_\d+_small\.png$/i.test(e.entryName)) ??
        entries.find((e) => /^Metadata\/plate_\d+\.png$/i.test(e.entryName));
      if (!entry) {
        this.platform.log.warn(
          `[${this.printerConfig.name}] No plate preview PNG found in the 3MF for the print thumbnail. Entries: ` +
            entries.map((e) => e.entryName).join(', '),
        );
        return;
      }
      const png = entry.getData();
      const path = this.printerConfig.githubPreviewImagePath ?? 'images/latest-print-preview.png';
      this.currentPrintThumbnailUrl = await this.uploadImageToGithub(png, path);
      if (this.currentPrintThumbnailUrl) {
        this.platform.log.info(`[${this.printerConfig.name}] Cached print preview thumbnail from ${entry.entryName}.`);
      }
    } catch (err) {
      this.platform.log.warn(
        `[${this.printerConfig.name}] Failed to extract print preview thumbnail: ${(err as Error).message}`,
      );
    }
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
    if (this.printerConfig.useLiveActivity) {
      await this.endLiveActivity({
        progress: 100,
        status: 'done',
        trailing: (filamentInfo || electricityCost !== undefined) ? `£${combinedTotal.toFixed(2)}` : undefined,
      });
    } else {
      await this.sendPingieNotificationWithSnapshot('✅ Print finished', combinedParts.join(' '));
    }

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

  // Sends a Live Activity start/update. The device-address URL is an upsert
  // per Pingie's docs: the first call starts the tile, every later call to
  // the same URL updates it - no activityId tracking needed on our side,
  // which also makes this naturally resilient to a Homebridge restart
  // mid-print (nothing in-memory to lose).
  private async updateLiveActivity(fields: {
    title?: string;
    body?: string;
    symbol?: string;
    tint?: string;
    progress?: number;
    endsIn?: number;
    trailing?: string;
    status?: string;
  }) {
    const { pingieDeviceId, pingieDeviceToken } = this.printerConfig;
    if (!pingieDeviceId || !pingieDeviceToken) {
      return;
    }
    try {
      const url = `https://push.getnotifyapp.com/live-activity/${encodeURIComponent(pingieDeviceId)}` +
        `?token=${encodeURIComponent(pingieDeviceToken)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.platform.log.warn(`[${this.printerConfig.name}] Live Activity update failed (${res.status}): ${body}`);
      }
    } catch (err) {
      this.platform.log.warn(`[${this.printerConfig.name}] Live Activity update error: ${(err as Error).message}`);
    }
  }

  // Ends the tile. Always called with final content so the last thing shown
  // isn't a frozen mid-progress state - per Pingie's own docs, forgetting
  // this is the most commonly missed step and leaves a stale tile for up to
  // 4 hours.
  private async endLiveActivity(fields: { progress?: number; status?: string; trailing?: string }) {
    const { pingieDeviceId, pingieDeviceToken } = this.printerConfig;
    if (!pingieDeviceId || !pingieDeviceToken) {
      return;
    }
    try {
      const url = `https://push.getnotifyapp.com/live-activity/${encodeURIComponent(pingieDeviceId)}` +
        `?token=${encodeURIComponent(pingieDeviceToken)}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keepFor: this.printerConfig.liveActivityKeepForSeconds ?? 300,
          ...fields,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.platform.log.warn(`[${this.printerConfig.name}] Live Activity end failed (${res.status}): ${body}`);
      }
    } catch (err) {
      this.platform.log.warn(`[${this.printerConfig.name}] Live Activity end error: ${(err as Error).message}`);
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
        `https://push.getnotifyapp.com/notify-json/${encodeURIComponent(pingieGroupId)}` +
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

      // If we'd previously alerted about a dropped connection, let them know
      // it's back rather than leaving that as the last thing they heard.
      const threshold = this.printerConfig.mqttReconnectAlertThreshold ?? 5;
      if (threshold > 0 && this.consecutiveReconnectFailures >= threshold) {
        void this.sendPingieNotificationWithSnapshot(
          '✅ Connection restored',
          `${this.printerConfig.name}: reconnected after ${this.consecutiveReconnectFailures} failed attempts.`,
        );
      }
      this.consecutiveReconnectFailures = 0;

      this.client!.subscribe(`device/${this.printerConfig.serialNumber}/report`, (err, granted) => {
        if (err) {
          this.platform.log.error(`[${this.printerConfig.name}] Subscribe failed: ${err.message}`);
        } else if (granted?.[0]?.qos === 128) {
          this.platform.log.error(
            `[${this.printerConfig.name}] Broker rejected the /report subscription (ACL denial) - ` +
              'this would explain the plugin not receiving any status at all.',
          );
        }
      });

      // Diagnostic-only, off by default - see enableRequestTopicSniffing.
      // Also watch the /request topic - not our own commands (those go out,
      // they don't loop back), but commands sent by OTHER clients on the same
      // broker, like Bambu Studio/Handy's native buttons. Lets us discover
      // things like the real AMS drying ams_id just by watching what Studio's
      // own "Dry" button sends, without needing a separate MQTT client tool.
      // Some brokers grant a subscription at the protocol level while quietly
      // denying it via an ACL (qos 128 in the granted response) rather than
      // returning a JS-level error - checked explicitly here since a silent
      // ACL denial would otherwise look identical to "no messages happened".
      if (this.printerConfig.enableRequestTopicSniffing) {
        this.client!.subscribe(`device/${this.printerConfig.serialNumber}/request`, (err, granted) => {
          if (err) {
            this.platform.log.warn(`[${this.printerConfig.name}] Couldn't subscribe to /request: ${err.message}`);
          } else if (granted?.[0]?.qos === 128) {
            this.platform.log.warn(
              `[${this.printerConfig.name}] Broker rejected the /request subscription (ACL denial) - ` +
                'the printer likely doesn\'t allow third-party clients to listen to command traffic, ' +
                'even though it accepts commands published there. The AMS ID sniffer won\'t work; ' +
                'you\'ll need to find it another way (e.g. a working MQTT client tool, if one connects).',
            );
          } else {
            this.platform.log.info(`[${this.printerConfig.name}] Subscribed to /request (granted qos=${granted?.[0]?.qos}).`);
          }
        });
      }

      this.requestFullState();
      this.startRefreshTimer();
    });

    this.client.on('message', (topic, payload) => {
      if (topic.endsWith('/report')) {
        this.handleMessage(payload);
      } else if (topic.endsWith('/request')) {
        this.sniffOtherClientCommand(payload);
      }
    });

    this.client.on('error', (err) => {
      this.platform.log.warn(`[${this.printerConfig.name}] MQTT error: ${err.message}`);
    });

    this.client.on('close', () => {
      this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, false);
      this.stopRefreshTimer();

      this.consecutiveReconnectFailures += 1;
      const threshold = this.printerConfig.mqttReconnectAlertThreshold ?? 5;
      if (threshold > 0 && this.consecutiveReconnectFailures % threshold === 0) {
        void this.sendPingieNotificationWithSnapshot(
          '⚠️ Connection lost',
          `${this.printerConfig.name}: unable to reconnect after ${this.consecutiveReconnectFailures} attempts. ` +
            'Check the printer and current print status.',
        );
      }

      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    if (this.printerConfig.enableNetworkPresenceCheck) {
      // Ping-gated mode: check presence on a fixed interval, only attempt a
      // real MQTT connection if the printer actually answers. Skips the
      // connection attempt entirely (but keeps checking) if it doesn't.
      const intervalSeconds = this.printerConfig.presenceCheckIntervalSeconds ?? 30;
      this.reconnectTimer = setTimeout(async () => {
        this.reconnectTimer = undefined;
        // Fail OPEN, not closed: if the ping check itself errors (e.g. no
        // `ping` binary or no raw-ICMP permission in this environment - a
        // real risk in minimal Docker containers), that's a broken presence
        // check, not evidence the printer is unreachable. Falls back to
        // attempting the real connection rather than silently refusing to
        // reconnect forever because of an environment limitation.
        let alive = true;
        let checkFailed = false;
        try {
          const res = await ping.promise.probe(this.printerConfig.ipAddress);
          alive = res.alive;
        } catch (err) {
          checkFailed = true;
          if (!this.loggedPingUnavailableWarning) {
            this.loggedPingUnavailableWarning = true;
            this.platform.log.warn(
              `[${this.printerConfig.name}] Presence check (ping) isn't working in this environment ` +
                `(${(err as Error).message}) - falling back to reconnecting without it. Consider setting ` +
                'enableNetworkPresenceCheck to false if this persists.',
            );
          }
        }

        if (alive || checkFailed) {
          if (!checkFailed) {
            this.platform.log.info(`[${this.printerConfig.name}] Printer is on the network - attempting reconnect.`);
          }
          this.connect();
        } else {
          this.platform.log.debug(`[${this.printerConfig.name}] Printer not reachable - skipping connection attempt.`);
          this.scheduleReconnect(); // keep checking on the same interval
        }
      }, intervalSeconds * 1000);
      return;
    }

    // Default mode: exponential backoff, no presence check. Doubles each
    // consecutive failure (capped at reconnectMaxDelaySeconds), resetting to
    // the base delay on the next successful connect. If a hang involves any
    // kind of resource contention on the printer's side, repeatedly
    // hammering it with fresh connection attempts every few seconds
    // indefinitely could plausibly be adding load to something already
    // struggling rather than helping - this backs off instead of retrying
    // at a constant rate forever.
    const baseDelay = this.printerConfig.reconnectDelaySeconds ?? 10;
    const maxDelay = this.printerConfig.reconnectMaxDelaySeconds ?? 300;
    const multiplier = Math.pow(2, Math.min(this.consecutiveReconnectFailures, 10));
    const delaySeconds = Math.min(baseDelay * multiplier, maxDelay);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.platform.log.info(`[${this.printerConfig.name}] Reconnecting... (next attempt after ${delaySeconds}s if this fails)`);
      this.connect();
    }, delaySeconds * 1000);
  }

  private startRefreshTimer() {
    this.stopRefreshTimer();
    // Off by default (0). The printer already pushes updates continuously on
    // its own, and a full refresh already happens on every (re)connect - the
    // periodic version only guards against a message silently vanishing
    // while the connection stays up the whole time, which is a rare edge
    // case compared to an actual disconnect (already handled separately).
    // Set a positive value only if you want that extra safety net back.
    const seconds = this.printerConfig.refreshIntervalSeconds ?? 0;
    if (seconds <= 0) {
      return;
    }
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

  // Watches commands sent by OTHER clients (Bambu Studio, Handy, the
  // touchscreen) on the same broker - never our own outgoing commands, those
  // don't loop back to us. Purely diagnostic/logging, changes no state.
  private sniffOtherClientCommand(payload: Buffer) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload.toString());
    } catch {
      this.platform.log.debug(`[${this.printerConfig.name}] Received unparseable /request payload.`);
      return;
    }
    const printCommand = (parsed?.print as Record<string, unknown> | undefined)?.command;
    this.platform.log.debug(
      `[${this.printerConfig.name}] Observed /request traffic - command="${printCommand ?? 'none'}".`,
    );
    if (printCommand === 'ams_filament_drying') {
      const amsId = (parsed.print as Record<string, unknown>).ams_id;
      this.platform.log.info(
        `[${this.printerConfig.name}] Observed an AMS drying command from another client - ` +
          `ams_id=${amsId}. Use this value for the "amsId" config field.`,
      );
    } else if (printCommand) {
      // Any other command from another client - logged for visibility/future
      // debugging, not specially handled.
      this.platform.log.debug(
        `[${this.printerConfig.name}] Observed command "${printCommand}" from another client.`,
      );
    }
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

    // Preheating notifications - fires once when bed/nozzle actually starts
    // heading toward a real target, not repeatedly while it climbs. No chamber
    // equivalent: active chamber heating with a settable target is an X1E-only
    // feature, the X1 Carbon's chamber just warms passively. No time-to-target
    // estimate either - the printer doesn't report one, and a self-calculated
    // guess would be a genuine approximation, not real data.
    const HEATING_MARGIN_C = 2;
    const bedCurrent = Number(this.mergedState.bed_temper);
    const bedTarget = Number(this.mergedState.bed_target_temper);
    if (!Number.isNaN(bedCurrent) && !Number.isNaN(bedTarget)) {
      const bedHeatingNow = bedTarget > 0 && bedCurrent < bedTarget - HEATING_MARGIN_C;
      if (bedHeatingNow && !this.bedHeatingActive) {
        void this.sendPingieNotificationWithSnapshot(
          '🌡️ Bed heating',
          `${this.printerConfig.name}: ${bedCurrent.toFixed(0)}°C → ${bedTarget.toFixed(0)}°C.`,
        );
      }
      this.bedHeatingActive = bedHeatingNow;
    }
    if (this.bedTempService && !Number.isNaN(bedCurrent)) {
      this.bedTempService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, bedCurrent);
    }
    const nozzleCurrent = Number(this.mergedState.nozzle_temper);
    const nozzleTarget = Number(this.mergedState.nozzle_target_temper);
    if (!Number.isNaN(nozzleCurrent) && !Number.isNaN(nozzleTarget)) {
      const nozzleHeatingNow = nozzleTarget > 0 && nozzleCurrent < nozzleTarget - HEATING_MARGIN_C;
      if (nozzleHeatingNow && !this.nozzleHeatingActive) {
        void this.sendPingieNotificationWithSnapshot(
          '🌡️ Nozzle heating',
          `${this.printerConfig.name}: ${nozzleCurrent.toFixed(0)}°C → ${nozzleTarget.toFixed(0)}°C.`,
        );
      }
      this.nozzleHeatingActive = nozzleHeatingNow;
    }
    if (this.nozzleTempService && !Number.isNaN(nozzleCurrent)) {
      this.nozzleTempService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, nozzleCurrent);
    }
    if (this.chamberTempService) {
      const chamberCurrent = Number(this.mergedState.chamber_temper);
      if (!Number.isNaN(chamberCurrent)) {
        this.chamberTempService.updateCharacteristic(
          this.platform.Characteristic.CurrentTemperature,
          chamberCurrent,
        );
      }
    }

    // Door sensor - see the service setup comment for the verified bit
    // details. home_flag arrives as a (possibly negative) 32-bit signed int;
    // >>> 0 converts it to unsigned before the bitwise check.
    const homeFlag = this.mergedState.home_flag as number | undefined;
    if (typeof homeFlag === 'number') {
      const doorOpenNow = Boolean((homeFlag >>> 0) & 0x00800000);
      if (doorOpenNow !== this.doorOpen) {
        this.doorOpen = doorOpenNow;
        this.doorService.updateCharacteristic(
          this.platform.Characteristic.ContactSensorState,
          doorOpenNow
            ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
        );
      }
    }

    // AMS 2 Pro auto-dry threshold logic - only runs while the switch is on.
    // Humidity scale is NOT confirmed to be a true percentage (see config
    // comments) - logs a one-time hint if the raw value looks like it might
    // be a coarse 1-5 index instead, so thresholds can be recalibrated.
    if (this.amsAutoDryEnabled && this.printerConfig.amsId !== undefined) {
      const amsArray = (this.mergedState.ams as { ams?: Array<{ humidity?: string | number }> } | undefined)?.ams;
      const unitIndex = this.printerConfig.amsHumidityUnitIndex ?? 0;
      const rawHumidity = amsArray?.[unitIndex]?.humidity;
      const humidity = rawHumidity !== undefined ? Number(rawHumidity) : NaN;

      if (!Number.isNaN(humidity)) {
        if (!this.loggedHumidityScaleHint) {
          this.loggedHumidityScaleHint = true;
          this.platform.log.info(
            `[${this.printerConfig.name}] AMS humidity raw value: ${humidity}` +
              (humidity <= 5
                ? ' - this looks like it might be a coarse 1-5 index rather than a true percentage. ' +
                  'If your thresholds never trigger, this is likely why - adjust amsDryStartThreshold/' +
                  'amsDryStopThreshold to match this scale instead.'
                : ''),
          );
        }

        const startThreshold = this.printerConfig.amsDryStartThreshold ?? 50;
        const stopThreshold = this.printerConfig.amsDryStopThreshold ?? 40;

        if (!this.amsDryingActive && humidity >= startThreshold) {
          this.amsDryingActive = true;
          this.sendAmsDryCommand(true);
          void this.sendPingieNotificationWithSnapshot(
            '🌬️ AMS drying started',
            `${this.printerConfig.name}: humidity reached ${humidity} (threshold ${startThreshold}).`,
          );
        } else if (this.amsDryingActive && humidity <= stopThreshold) {
          this.amsDryingActive = false;
          this.sendAmsDryCommand(false);
          void this.sendPingieNotificationWithSnapshot(
            '🌬️ AMS drying stopped',
            `${this.printerConfig.name}: humidity dropped to ${humidity} (threshold ${stopThreshold}).`,
          );
        }
      }
    }

    // Fault/error alert - a nonzero print_error or any active hms entries means
    // something needs attention. The "Inspecting first layer" hms code is
    // pulled out separately below since it's informational, not a fault.
    const printError = this.mergedState.print_error as number | undefined;
    const hms = this.mergedState.hms as Array<{ attr?: number; code?: number }> | undefined;
    const hmsEntries = Array.isArray(hms) ? hms : [];
    const firstLayerCheckEntries = hmsEntries.filter(
      (e) => this.decodeHmsCode(e) === BambuPrinterAccessory.FIRST_LAYER_CHECK_HMS_CODE,
    );
    const realHmsEntries = hmsEntries.filter(
      (e) => this.decodeHmsCode(e) !== BambuPrinterAccessory.FIRST_LAYER_CHECK_HMS_CODE,
    );

    // First layer check - informational only, own low-key notification, no
    // effect on the Fault sensor.
    const firstLayerCheckActive = firstLayerCheckEntries.length > 0;
    if (firstLayerCheckActive !== this.firstLayerCheckActive) {
      this.firstLayerCheckActive = firstLayerCheckActive;
      if (firstLayerCheckActive) {
        void this.sendPingieNotificationWithSnapshot(
          '👁️ First layer check',
          `${this.printerConfig.name} is inspecting the first layer.`,
        );
      }
    }

    const faultNow = Boolean(printError && printError !== 0) || realHmsEntries.length > 0;
    if (faultNow !== this.faultPresent) {
      this.faultPresent = faultNow;
      const description = printError ? this.describeError(printError) : undefined;
      const hmsFormatted = realHmsEntries.map((e) => this.formatHmsEntry(e)).filter((s): s is string => Boolean(s));

      this.platform.log.info(
        `[${this.printerConfig.name}] Fault ${faultNow ? 'DETECTED' : 'CLEARED'} ` +
          `(print_error=${printError ?? 'none'}${description ? ` - ${description}` : ''}, ` +
          `hms=[${hmsFormatted.join('; ')}])`,
      );
      this.faultService.updateCharacteristic(
        this.platform.Characteristic.ContactSensorState,
        faultNow
          ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );
      if (faultNow) {
        const bodyParts: string[] = [];
        if (description) {
          bodyParts.push(`${this.printerConfig.name}: ${description} (${this.hexKeyForCode(printError!)})`);
        } else if (printError) {
          bodyParts.push(`${this.printerConfig.name}: print_error=${printError}`);
        }
        if (hmsFormatted.length > 0) {
          bodyParts.push(`HMS: ${hmsFormatted.join(', ')}`);
        }
        if (bodyParts.length === 0) {
          bodyParts.push(`${this.printerConfig.name} reported a fault. Check the printer.`);
        }
        void this.sendPingieNotificationWithSnapshot('🚨 Printer fault', bodyParts.join(' '));
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
      this.startCountdownTicker();
      this.currentPrintThumbnailUrl = undefined;

      this.platform.log.info(`[${this.printerConfig.name}] Print started.`);
      this.startedSwitchService.updateCharacteristic(
        this.platform.Characteristic.ProgrammableSwitchEvent,
        this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
      );

      // Live Activity mode: start the tile right away, even before a time
      // estimate exists - it can show progress=0 and pick up endsIn on the
      // next update once mc_remaining_time populates. Skips the regular push
      // notification stack entirely when this mode is on, per the whole
      // point of a Live Activity - one persistent tile, not a burst of pushes.
      if (this.printerConfig.useLiveActivity) {
        const jobName = this.mergedState.subtask_name as string | undefined;
        void this.updateLiveActivity({
          title: jobName ? jobName.slice(0, 120) : this.printerConfig.name,
          symbol: this.printerConfig.liveActivitySymbol ?? 'printer.fill',
          tint: this.printerConfig.liveActivityTint ?? '#FF6600',
          progress: 0,
          status: 'printing',
        });
      }

      // Delay the Pingie push (not the HomeKit switch above, which fires
      // instantly) so mc_remaining_time has a real chance to populate with
      // this print's own estimate first, rather than reporting "no estimate
      // yet" immediately.
      if (this.startNotificationTimer) {
        clearTimeout(this.startNotificationTimer);
      }
      const delaySeconds = this.printerConfig.startNotificationDelaySeconds ?? 30;
      this.startNotificationTimer = setTimeout(async () => {
        this.startNotificationTimer = undefined;
        const remaining = this.mergedState.mc_remaining_time as number | undefined;
        this.printEstimatedTotalMinutes = typeof remaining === 'number' && remaining > 0 ? remaining : undefined;
        const jobName = this.mergedState.subtask_name as string | undefined;
        // Awaited (not fire-and-forget) so the very first "Print started" push
        // already has the image ready, rather than racing it and only later
        // notifications picking it up once the fetch/upload finishes.
        await this.fetchAndCachePrintThumbnail();

        const parts = jobName
          ? [`Print started on ${this.printerConfig.name}: "${jobName}".`]
          : [`Print started on ${this.printerConfig.name}.`];
        const totalLayerNum = this.mergedState.total_layer_num as number | undefined;
        if (typeof totalLayerNum === 'number' && totalLayerNum > 0) {
          parts.push(`${totalLayerNum} layers.`);
        }
        if (this.printEstimatedTotalMinutes) {
          parts.push(`Estimated time: ${this.formatDuration(this.printEstimatedTotalMinutes)}.`);
          const cost = this.estimateCost(this.printEstimatedTotalMinutes);
          if (cost !== undefined) {
            parts.push(`Estimated cost: £${cost.toFixed(2)}.`);
          }
        } else {
          parts.push("No time estimate available from the printer yet - check the app for progress.");
        }

        if (this.printerConfig.useLiveActivity) {
          // Update the tile with the countdown now that it's available,
          // instead of sending the regular push.
          void this.updateLiveActivity({
            endsIn: this.printEstimatedTotalMinutes ? this.printEstimatedTotalMinutes * 60 : undefined,
          });
        } else {
          void this.sendPingieNotificationWithSnapshot('🖨️ Print started', parts.join(' '));
        }
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
      this.stopCountdownTicker();
    }

    // Print-failed handling - a failed/cancelled print never reaches FINISH,
    // so without this nothing would clean up: timers keep running, and with
    // Live Activities the tile would stay stuck showing stale progress for
    // up to Apple's 8-hour cap. Pre-existing gap, not new to this feature -
    // worth fixing regardless of whether Live Activities are in use.
    if (gcodeState === 'FAILED' && this.previousGcodeState !== 'FAILED') {
      const elapsedMinutes = this.printStartTimestamp
        ? (Date.now() - this.printStartTimestamp) / 60_000
        : undefined;

      this.platform.log.info(
        `[${this.printerConfig.name}] Print failed/cancelled` +
          (elapsedMinutes ? ` - after ${this.formatDuration(elapsedMinutes)}` : ''),
      );

      if (this.printerConfig.useLiveActivity) {
        void this.endLiveActivity({ status: 'failed' });
      } else {
        void this.sendPingieNotificationWithSnapshot(
          '❌ Print failed',
          `${this.printerConfig.name}: print stopped/failed` +
            (elapsedMinutes ? ` after ${this.formatDuration(elapsedMinutes)}` : '') + '.',
        );
      }

      this.printStartTimestamp = undefined;
      this.printEstimatedTotalMinutes = undefined;
      this.stopCountdownTicker();
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
      this.progressService?.updateCharacteristic(
        this.platform.Characteristic.Active,
        occupied
          ? this.platform.Characteristic.Active.ACTIVE
          : this.platform.Characteristic.Active.INACTIVE,
      );
      this.countdownService?.updateCharacteristic(
        this.platform.Characteristic.Active,
        occupied
          ? this.platform.Characteristic.Active.ACTIVE
          : this.platform.Characteristic.Active.INACTIVE,
      );
      this.countdownService?.updateCharacteristic(
        this.platform.Characteristic.InUse,
        occupied
          ? this.platform.Characteristic.InUse.IN_USE
          : this.platform.Characteristic.InUse.NOT_IN_USE,
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
      // Suppress the notification during the post-command cooldown - see
      // setPrintSpeed for why. The slider still updates live either way.
      if (Date.now() >= this.speedCommandCooldownUntil) {
        this.notifySpeedChange(spdLvl);
      }
    }

    const mcPercent = this.mergedState.mc_percent as number | undefined;
    if (typeof mcPercent === 'number') {
      const clamped = Math.max(0, Math.min(100, Math.round(mcPercent)));
      if (clamped !== this.printProgressPercent) {
        this.printProgressPercent = clamped;
        this.progressService?.updateCharacteristic(
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

          if (this.printerConfig.useLiveActivity) {
            void this.updateLiveActivity({
              progress: bucket,
              endsIn:
                typeof remaining === 'number' && remaining >= 0 ? remaining * 60 : undefined,
              status: 'printing',
            });
          } else {
            const remainingText =
              typeof remaining === 'number' && remaining >= 0
                ? `${this.formatDuration(remaining)} remaining`
                : 'time remaining not available yet';
            const layerNum = this.mergedState.layer_num as number | undefined;
            const totalLayerNum = this.mergedState.total_layer_num as number | undefined;
            const layerText =
              typeof layerNum === 'number' && typeof totalLayerNum === 'number' && totalLayerNum > 0
                ? ` Layer ${layerNum}/${totalLayerNum}.`
                : '';
            void this.sendPingieNotificationWithSnapshot(
              '🖨️ Print progress',
              `${this.printerConfig.name}: ${bucket}% complete - ${remainingText}.${layerText}`,
            );
          }
        }
      }
    }

    // Countdown timer - resync the locally-ticking counter to the real
    // mc_remaining_time whenever a fresh value arrives (minute precision from
    // the printer), so the per-second local ticking can't drift far between
    // updates.
    const remainingMinutes = this.mergedState.mc_remaining_time as number | undefined;
    if (occupied && typeof remainingMinutes === 'number' && remainingMinutes >= 0) {
      this.countdownSecondsRemaining = Math.min(remainingMinutes * 60, 2000 * 60);
    }
  }

  private countdownLightSensorValue(): number {
    const totalSeconds = Math.max(0, this.countdownSecondsRemaining);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    // HAP light sensor values must be > 0 per spec convention - 0.0001 reads
    // as "0m 00s" for practical purposes without violating that.
    const value = minutes + seconds / 100;
    return Math.max(0.0001, Math.round(value * 100) / 100);
  }

  private startCountdownTicker() {
    this.stopCountdownTicker();
    this.countdownTicker = setInterval(() => {
      if (this.countdownSecondsRemaining > 0) {
        this.countdownSecondsRemaining -= 1;
      }
      this.countdownService?.updateCharacteristic(
        this.platform.Characteristic.CurrentAmbientLightLevel,
        this.countdownLightSensorValue(),
      );
    }, 1000);
  }

  private stopCountdownTicker() {
    if (this.countdownTicker) {
      clearInterval(this.countdownTicker);
      this.countdownTicker = undefined;
    }
    this.countdownSecondsRemaining = 0;
    this.countdownService?.updateCharacteristic(
      this.platform.Characteristic.CurrentAmbientLightLevel,
      this.countdownLightSensorValue(),
    );
  }

  public shutdown() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.startNotificationTimer) {
      clearTimeout(this.startNotificationTimer);
    }
    if (this.countdownTicker) {
      clearInterval(this.countdownTicker);
    }
    if (this.speedCommandCorrectionTimer) {
      clearTimeout(this.speedCommandCorrectionTimer);
    }
    this.stopRefreshTimer();
    this.client?.end(true);
  }
}
