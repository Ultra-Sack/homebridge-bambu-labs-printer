# homebridge-bambu-print-status

Exposes a Bambu Lab printer to HomeKit as:

- An **Occupancy Sensor** — occupied while actively printing, clear when idle/finished.
  Intended for driving an automation that powers a smart plug off overnight once
  printing has stopped.
- A **Lightbulb** — on/off control of the physical chamber LED strip, with state
  read back from the printer so it stays in sync if changed from the touchscreen
  or the Bambu app.
- A **Switch ("Pause")** — On while the printer is paused, Off while running;
  toggling it sends the `pause`/`resume` MQTT command. Stays in sync if paused or
  resumed from the touchscreen or app. (No "Stop"/cancel control - that's a
  one-way destructive action a toggle switch doesn't represent well, and it isn't
  included here.)
- A **Contact Sensor ("Door")** — uses standard semantics (closed = detected,
  open = not detected), matching every other HomeKit door/window sensor, so it
  works naturally in the Home app's own automation builder - e.g. "when Door
  opens and Occupancy is not detected, turn on Light" needs no extra plugin
  code, just a normal HomeKit automation using accessories already exposed
  here. Verified against real captured MQTT data (`home_flag` bit
  `0x00800000`) - this signal was confirmed broken on X1C firmware
  01.08.02.00 (Jan 2025) and confirmed working on 01.10.00.00 (Oct 2025), so
  it should be fine on any reasonably current firmware, but worth a quick
  physical door-open test to confirm on yours.
- Three **Temperature Sensors ("Bed Temp"/"Nozzle Temp"/"Chamber Temp")** —
  *off by default*, only appear if `showTemperatureSensors: true` is set.
  Ranges are extended beyond HomeKit's default 0-100°C cap (nozzle up to
  350°C, bed up to 150°C) so real readings don't get silently clipped.
- A **Switch ("AMS Auto-Dry")** — experimental, opt-in (only appears if `amsId`
  is configured). Enables/disables automatic threshold-based AMS 2 Pro drying -
  not a direct dryer toggle, and deliberately not a humidity sensor tile. See
  **AMS 2 Pro auto-dry (experimental)** below - this one has real unresolved
  unknowns and needs calibration against your own logs.
- A **Fan ("Progress")** — HomeKit has no native progress bar, so this repurposes
  a Fan's rotation-speed slider (0–100%) to show live print completion percentage,
  read straight from the printer's own `mc_percent` field rather than estimated
  from time. It's read-only: dragging the slider or toggling it in the Home app
  just snaps back to the real value.
- A **Fan ("Speed")** — snapped to exactly 4 positions (25/50/75/100%), mapped
  to Bambu's Silent/Standard/Sport/Ludicrous speed profiles. Sends the
  `print_speed` MQTT command with the level as a JSON string (`"1"`-`"4"`) -
  deliberately never a bare number, since there's a documented firmware bug
  (confirmed on P1 series, plausibly others) where sending the wrong type
  causes a garbage speed multiplier. **Real limitation:** the Home app only
  shows a percentage on the slider, not the profile name - there's no way to
  label slider positions in stock Home app. 25%=Silent, 50%=Standard,
  75%=Sport, 100%=Ludicrous.
- A **Speed changed notification** — sent whenever the print speed profile
  changes, whether triggered from HomeKit or externally (touchscreen/app),
  since both paths update the same tracked value.
- A **Programmable Switch ("Started")** — fires a single press when a print begins
  (a genuine start, not a resume from pause), and sends a Pingie push with the
  estimated duration and (if configured) estimated electricity cost.
- A **Programmable Switch ("Finished")** — fires on completion, and sends a Pingie
  push with the actual elapsed time and cost.
- A **Contact Sensor ("Fault")** — opens (triggers) whenever the printer reports a
  nonzero `print_error` or an active HMS entry, and sends a Pingie push
  describing it - including a real decoded description for the HMS code where
  one exists (sourced directly from Bambu's own official wiki, ~380 codes
  bundled), a working deep link to `e.bambulab.com`, and falling back to just
  the raw code if it's not in the table - so a failed print notifies you with
  an actual explanation instead of you finding it hours later. The "Inspecting
  first layer" HMS code is treated separately (see below) rather than
  triggering this sensor, since it's informational, not a fault.
- A **Contact Sensor ("Filament")** — opens when a `print_error` code you've
  confirmed corresponds to a filament run-out on your printer occurs, and sends
  a Pingie push. See **Filament run-out setup** below - this one needs a bit of
  setup, it isn't reliable out of the box.

All accessories for a printer share one MQTT connection.

## Pingie Notify! setup

Notifications go through Pingie's ["Notify!"](https://notify.pingie.com/apidocs/)
group push API. You need **both** a Group ID (`GRP...`) and its matching Group
Token from the Notify! app - the ID alone isn't enough to send. Put them in
`pingieGroupId` / `pingieGroupToken`. Leave both blank to disable notifications
entirely (the sensors/switches still work in HomeKit either way).

`pingieIconUrl` (optional) sets the small circular sender icon shown next to the
title. `pingieImageUrl` (optional, separate field) sets a larger hero image shown
when the notification is expanded - both must be HTTPS links to a JPEG/PNG/GIF.
Both are configurable from the Homebridge UI config screen, no manual JSON editing
needed.

Each notification type has a distinct emoji prefix in its title so they're easy
to tell apart at a glance:

| Notification | Title |
|---|---|
| Print started | 🖨️ Print started |
| Print progress | 🖨️ Print progress (every 5%, configurable) |
| Bed heating | 🌡️ Bed heating (once, when it starts) |
| Nozzle heating | 🌡️ Nozzle heating (once, when it starts) |
| Print finished | ✅ Print finished |
| Printer fault | 🚨 Printer fault |
| Filament run-out | 🧵⚠️ Filament run-out |
| Connection lost | ⚠️ Connection lost (after N failed reconnects, configurable) |
| Connection restored | ✅ Connection restored |

## Electricity cost estimates

The printer doesn't report actual power draw over MQTT, so cost is calculated as
`averagePrintWattage ÷ 1000 × hours × electricityRatePencePerKwh`, not a metered
reading. Bambu's own spec sheet lists the X1 Carbon around 350–1000W depending on
stage (bed/nozzle heating draws far more than steady-state printing), so a
sensible average across a whole print is usually well under the peak figure -
if you have a metering smart plug, check its live wattage reading over a full
print and average it for a more accurate number. Leave `averagePrintWattage` or
`electricityRatePencePerKwh` blank to get duration-only notifications with no
cost line.

Connects directly to the printer's local MQTT interface — no cloud account,
no Bambu Handy binding required.

## Why an Occupancy Sensor?

It's the HomeKit service type built for "is this space/thing in active use" and
is what the Home app's automation UI expects for triggers like "when Printer
becomes unoccupied, turn off Printer Plug." A Motion Sensor would be semantically
wrong (nothing is moving), and a Switch would look controllable, which this isn't.

The sensor also has a `StatusActive` characteristic that goes false whenever the
plugin loses its MQTT connection, so a dropped connection can't be misread by an
automation as "idle" and cut power mid-print.

## Prerequisites

1. **LAN-only mode enabled** on the printer (Settings > General on the printer,
   or via Bambu Studio/Handy). This exposes the local MQTT broker on port 8883.
2. **A fixed IP address** for the printer — either set statically on the printer,
   or reserved via a DHCP reservation on your router. The plugin (and the RTSP
   camera stream, if you use one) both hardcode this address; if it changes, the
   connection breaks until you update the config.
3. The printer's **serial number** and **LAN access code**:
   - Serial number: printer touchscreen > Settings (cog) > General, or the
     Bambu Handy app's device info page.
   - Access code: printer touchscreen > Settings (cog) > General, shown in
     green text (not the Network page).

## Installing without a build step

This package ships a pre-built `dist/` folder, so on your Homebridge server you
only need to install the one runtime dependency and restart - no TypeScript
compiler required there:

```bash
cd homebridge-bambu-print-status
npm install --omit=dev
```

Then restart Homebridge. If you ever edit `src/` yourself, rebuild on a machine
that has the full devDependencies (`npm install && npm run build`) and copy the
resulting `dist/` folder across - most Homebridge Docker images don't have
TypeScript installed, so building directly on the NAS/container will fail.

## Configuration

```jsonc
{
  "platform": "BambuPrintStatus",
  "name": "Bambu Print Status",
  "printers": [
    {
      "name": "X1 Carbon",
      "ipAddress": "192.168.1.50",
      "serialNumber": "01S00C123456789",
      "lanAccessCode": "12345678",
      "mqttPort": 8883,
      "mqttUsername": "bblp",
      "rejectUnauthorized": false,
      "refreshIntervalSeconds": 60,
      "reconnectDelaySeconds": 10,
      "activeStates": ["RUNNING", "PREPARE", "PAUSE", "SLICING"],
      "filamentRunoutErrorCodes": [],
      "pingieGroupId": "GRP56789",
      "pingieGroupToken": "GROUP_TOKEN_HERE",
      "averagePrintWattage": 180,
      "electricityRatePencePerKwh": 24.5
    }
  ]
}
```

`activeStates` controls which `gcode_state` values count as "occupied." The
defaults treat a filament-change `PAUSE` as still occupied, so an automation
won't power off the plug mid-print. Other states you may see: `IDLE`, `FINISH`,
`FAILED` — these are left out of the default active list on purpose.

## How it works

- Subscribes to `device/<serial>/report` over MQTT/TLS (self-signed cert, hence
  `rejectUnauthorized: false` by default).
- On connect, and every `refreshIntervalSeconds`, publishes a `pushall` request
  to `device/<serial>/request` — Bambu printers otherwise only send *diffs*
  after the first message, so this keeps the plugin's view of state complete
  rather than relying on catching every partial update.
- Merges each incoming message into a cached state object and re-derives
  `gcode_state` from it, only touching HomeKit when occupancy actually changes.
- Reconnects automatically after `reconnectDelaySeconds` on disconnect, and
  marks the sensor `StatusActive: false` while disconnected.

## Suggested automation

In the Home app: Automation > printer's Occupancy Sensor > "Not Detected" +
a time condition (e.g. after 10pm) > turn off the smart plug. Adding the time
condition avoids the plug cycling off every time a print simply finishes during
the day.

For the "Finished" switch: Automation > printer's Finished switch > "Single Press"
> Notification. For the "Fault" sensor: Automation > Fault sensor > "Opened" >
Notification.

## Preheating notifications

Fires once when the bed or nozzle actually starts heading toward a real
target (more than 2°C below it), not repeatedly while it climbs:

**🌡️ Bed heating**
> X1 Carbon: 24°C → 60°C.

**🌡️ Nozzle heating**
> X1 Carbon: 25°C → 220°C.

No chamber equivalent - active chamber heating with a settable target is an
X1E-only feature; the X1 Carbon's chamber just warms passively from the
bed/nozzle inside the enclosure, so there's no meaningful "target" to notify
about. No time-to-target estimate either - the printer doesn't report one,
and a self-calculated guess (extrapolating from the current rate of rise)
would be a genuine approximation rather than real data, and heating curves
slow down noticeably as they approach target, so a naive estimate would
consistently run optimistic.

## First layer check notification

Bambu's AI camera monitoring reports an "Inspecting first layer" HMS code
(`0C00-0300-0003-000B`) during essentially every normal print that has this
feature enabled - it's informational, not a fault, so it's pulled out of fault
detection entirely and sent as its own notification instead:

**👁️ First layer check**
> X1 Carbon is inspecting the first layer.

This does not open the Fault contact sensor and does not use the alarm emoji -
genuine first-layer *problems* (spaghetti detected, defects found, inspection
timed out, etc.) are separate HMS codes that still correctly trigger the
regular 🚨 Printer fault notification.

## Error code descriptions

Fault and filament-run-out notifications include a human-readable description
where one is available, via a bundled lookup table of ~270 Bambu `print_error`
codes ([source](https://github.com/suchmememanyskill/bambu-error-codes), itself
derived from the [ha-bambulab](https://github.com/greghesp/ha-bambulab) Home
Assistant integration). **This is a community-maintained mapping, not official
Bambu Lab documentation, and it has known gaps** - some codes genuinely aren't
in it yet (see [this open issue](https://github.com/greghesp/ha-bambulab/issues/525)
for an example). When a code isn't found, the notification falls back to the
raw numeric code instead of guessing.

## Live camera snapshots in notifications

Setting `includeCameraSnapshot: true` attaches a current camera frame to
notifications, shown as the icon (visible immediately in the notification, not
only when tapped). Since Pingie's servers fetch the URL themselves, it has to
be publicly reachable - this works by pulling the snapshot from **camera.ui's
own REST API** (reusing the connection camera.ui already holds with the
printer, rather than opening a second competing one), then uploading it to a
**public** GitHub repo via the Contents API, overwriting one fixed file
(`githubSnapshotPath`) each time and linking to it via `raw.githubusercontent.com`
with a timestamp query param so the CDN doesn't serve a stale cached copy.

Requirements:
- camera.ui reachable at `cameraUiBaseUrl`, with the printer already added as a
  camera there under `cameraUiCameraName` (must match its exact registered name)
- A camera.ui username/password with access to that camera - consider a
  dedicated low-privilege account rather than your main admin login, since the
  credentials sit in plugin config
- A **public** GitHub repo (private repos return 404/login to unauthenticated
  fetchers like Pingie)
- A GitHub **fine-grained** Personal Access Token scoped to only
  "Contents: read and write" on that one repo

The plugin logs into camera.ui once, caches the JWT until shortly before it
expires, and re-logs-in automatically - no manual token refresh needed. If
capture or upload fails for any reason, the notification still sends as plain
text; a missing snapshot never blocks the underlying alert.

## Filament cost from the sliced 3MF file

When a print finishes, the plugin fetches the current project's sliced `.3mf`
file over FTPS (reusing the same LAN access code as MQTT/RTSP, port 990,
implicit FTPS), reads the slicer's own embedded filament-weight metadata, and
sends **three** notifications in this order:

1. **✅ Print finished** - elapsed time + combined total cost (filament + electricity)
2. **🧵 Filament cost** - per-material weight and cost breakdown, only sent if the
   fetch/parse succeeded
3. **⚡ Electricity cost** - elapsed time + electricity cost alone (always sent,
   independent of whether filament data was available)

This works for **any** filament, genuine or third-party, since it's the
slicer's own calculated weight - not AMS RFID-based remaining-% tracking,
which only works for genuine Bambu spools.

Configure prices via `filamentPricesPerKg` (e.g. `{"PLA": 18.99, "PETG": 22.99}`).
A material not in this map still shows its weight in the breakdown, just with
"price not set" instead of a cost, and is excluded from the total (noted as
"some materials unpriced" rather than silently treated as free).

**Two real uncertainties worth knowing about:**
- **The file path.** This assumes the project sits at `/cache/<subtask_name>.3mf`
  (the convention when a print is sent from Bambu Studio), falling back to
  root if not found there. If your prints are started a different way, this
  might not find the file - check the log for "Couldn't find the project file"
  and the exact paths it tried.
- **The XML schema.** The exact attribute names Bambu Studio uses inside the
  3MF's `Metadata/slice_info.config` for material type and weight aren't
  independently verified here - if parsing comes up empty, the log prints the
  raw XML/entry content it found instead of guessing, so the actual field
  names can be confirmed and the code adjusted if needed.

**Also worth knowing:** this opens a new FTP connection to the printer for
every finished print. Given the camera's single-connection limit caused a real
issue earlier, this hasn't been battle-tested for similar contention - worth
watching the printer's health after a few real prints before fully trusting it
during something you care about.

## AMS 2 Pro auto-dry (experimental)

Opt-in - only active if `amsId` is set in config. Adds a **Switch ("AMS
Auto-Dry")** that enables/disables automatic drying based on humidity
crossing thresholds (hysteresis: starts at `amsDryStartThreshold`, stops at
`amsDryStopThreshold`), plus four notifications:

**🌬️ AMS Auto-Dry enabled** / **🌬️ AMS Auto-Dry disabled** - when you toggle
the feature itself.

**🌬️ AMS drying started** / **🌬️ AMS drying stopped** - when the automation
actually starts/stops drying because a threshold was crossed.

**Two real, unresolved unknowns before you rely on this:**

- **The drying command's `ams_id`** doesn't follow the simple 0-3 unit
  numbering used everywhere else in the protocol. It's reverse-engineered
  from community experimentation (confirmed working by the person who found
  it, using `131`) - there's no auto-detection built into the command itself,
  but the plugin watches the `/request` topic for commands sent by *other*
  clients (Bambu Studio, Handy, the touchscreen) on the same connection -
  press the native "Dry" button in Bambu Studio's Device page and check the
  Homebridge log for a line like `Observed an AMS drying command from
  another client - ams_id=131`, no separate MQTT tool needed.
- **Humidity threshold scale isn't confirmed to be a true percentage.** Even
  an actively-maintained community integration has an *open, unanswered*
  GitHub issue asking exactly this question - the protocol clearly exposes a
  coarse 1-5 "index" in some contexts, while Bambu's own Handy app shows a
  real percentage from an unidentified source. The plugin logs the raw
  humidity value once with a hint if it looks like the coarse scale
  (`<= 5`) - check the Homebridge log after enabling and adjust
  `amsDryStartThreshold`/`amsDryStopThreshold` to match whatever it actually
  shows, since the 50/40 defaults assume a real percentage.

**Safety notes:** `amsDryTargetTemp` is clamped to a minimum of 45°C - the
reverse-engineered command reportedly does nothing below that. The switch
defaults to **Off on every Homebridge restart** rather than persisting state,
deliberately - resuming a heater unattended after a restart isn't a
reasonable default. Turning the switch off also immediately stops any drying
it started. `amsDryDurationHours` (default 8) is sent as a hardware-level
failsafe duration independent of this plugin's own stop command, in case that
command never arrives for any reason (e.g. a dropped connection).

## Filament run-out setup

Bambu printers don't expose a clean, separate "out of filament" flag over MQTT -
a run-out just pauses the print (`gcode_state` becomes `PAUSE`) with a
`print_error` code, the same mechanism used for other pauses. `filamentRunoutErrorCodes`
now ships pre-filled with the run-out codes identified in the community mapping
above (covering the external spool and each AMS slot), so the Filament sensor
should work out of the box. If a real run-out doesn't trip it, check the
Homebridge log - unmatched pauses are logged with their code so you can add it
to the list:

```
Paused with print_error=83935248 (0500_4008) - Starting printing failed. please
power cycle the printer and resend the print job. If this was a filament
run-out not already covered by the default list, add "0500_4008" to
filamentRunoutErrorCodes in the config to have the Filament sensor track it.
```
