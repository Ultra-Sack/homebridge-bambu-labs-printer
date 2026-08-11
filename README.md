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
- A **Fan ("Progress")** — HomeKit has no native progress bar, so this repurposes
  a Fan's rotation-speed slider (0–100%) to show live print completion percentage,
  read straight from the printer's own `mc_percent` field rather than estimated
  from time. It's read-only: dragging the slider or toggling it in the Home app
  just snaps back to the real value.
- A **Programmable Switch ("Started")** — fires a single press when a print begins
  (a genuine start, not a resume from pause), and sends a Pingie push with the
  estimated duration and (if configured) estimated electricity cost.
- A **Programmable Switch ("Finished")** — fires on completion, and sends a Pingie
  push with the actual elapsed time and cost.
- A **Contact Sensor ("Fault")** — opens (triggers) whenever the printer reports a
  nonzero `print_error` or an active HMS entry, and sends a Pingie push describing
  it, so a failed print notifies you instead of you finding it hours later.
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
| Print finished | ✅ Print finished |
| Printer fault | 🚨 Printer fault |
| Filament run-out | 🧵⚠️ Filament run-out |

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
