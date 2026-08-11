import { Service, PlatformAccessory } from 'homebridge';
import * as mqtt from 'mqtt';
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
}

const DEFAULT_ACTIVE_STATES = ['RUNNING', 'PREPARE', 'PAUSE', 'SLICING'];

export class BambuPrinterAccessory {
  private readonly service: Service;
  private readonly lightService: Service;
  private readonly progressService: Service;
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
  private printStartTimestamp?: number;
  private printEstimatedTotalMinutes?: number;
  private lastNotifiedProgressBucket = -1;
  private cameraUiToken?: string;
  private cameraUiTokenExpiresAt = 0;

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
      this.accessory.getService(this.platform.Service.Fanv2) ||
      this.accessory.addService(this.platform.Service.Fanv2, `${printerConfig.name} Progress`);
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
      const remaining = this.mergedState.mc_remaining_time as number | undefined;
      this.printEstimatedTotalMinutes = typeof remaining === 'number' && remaining > 0 ? remaining : undefined;

      this.platform.log.info(
        `[${this.printerConfig.name}] Print started` +
          (this.printEstimatedTotalMinutes
            ? ` - estimated ${this.formatDuration(this.printEstimatedTotalMinutes)}`
            : ' - no time estimate yet'),
      );
      this.startedSwitchService.updateCharacteristic(
        this.platform.Characteristic.ProgrammableSwitchEvent,
        this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
      );

      const parts = [`Print started on ${this.printerConfig.name}.`];
      if (this.printEstimatedTotalMinutes) {
        parts.push(`Estimated time: ${this.formatDuration(this.printEstimatedTotalMinutes)}.`);
        const cost = this.estimateCost(this.printEstimatedTotalMinutes);
        if (cost !== undefined) {
          parts.push(`Estimated cost: £${cost.toFixed(2)}.`);
        }
      } else {
        parts.push("No time estimate available yet from the printer - check again once it's underway.");
      }
      void this.sendPingieNotificationWithSnapshot('🖨️ Print started', parts.join(' '));
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

      const parts = [`Print finished on ${this.printerConfig.name}.`];
      if (elapsedMinutes !== undefined) {
        parts.push(`Took ${this.formatDuration(elapsedMinutes)}.`);
        const cost = this.estimateCost(elapsedMinutes);
        if (cost !== undefined) {
          parts.push(`Estimated cost: £${cost.toFixed(2)}.`);
        }
      }
      void this.sendPingieNotificationWithSnapshot('✅ Print finished', parts.join(' '));

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
    this.stopRefreshTimer();
    this.client?.end(true);
  }
}
