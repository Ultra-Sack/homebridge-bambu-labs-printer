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
  just snaps back to the real value. **Configurable via `progressDisplayMode`**
  (default `"both"`) - set to `"valve"` to hide this one, see below.
- A **Fan ("Speed")** — snapped to exactly 4 positions (25/50/75/100%), mapped
  to Bambu's Silent/Standard/Sport/Ludicrous speed profiles. Sends the
  `print_speed` MQTT command with the level as a JSON string (`"1"`-`"4"`) -
  deliberately never a bare number, since there's a documented firmware bug
  (confirmed on P1 series, plausibly others) where sending the wrong type
  causes a garbage speed multiplier. **Real limitation:** the Home app only
  shows a percentage on the slider, not the profile name - there's no way to
  label slider positions in stock Home app. Slider range is 0/25/50/75/100 -
  0 isn't a real speed and is safely rejected/reverted if selected (only
  1-4/25-100 are valid), it's just there to match HomeKit's true default
  minValue for better compatibility with the Home app's cached characteristic
  range. 25%=Silent, 50%=Standard, 75%=Sport, 100%=Ludicrous.
- A **Light Sensor ("Countdown")** — repurposes `CurrentAmbientLightLevel`
  (lux) to show time remaining as MM.SS - whole number is minutes, decimal is
  seconds (e.g. `222.30` = 3h 42m 30s). Ticks locally once per second between
  real `mc_remaining_time` updates (which only have minute precision from the
  printer), resyncing to the real value whenever a fresh one arrives so it
  can't drift far - gives a smoothly counting-down display rather than one
  that jumps once a minute. **Pauses correctly**: the local per-second tick
  stops while the printer is paused, rather than continuing to drain time
  that isn't actually elapsing. **Untested display precision:** Home app's
  own lux formatting may not show two decimal places consistently, which
  could make single-digit seconds (e.g. `45.06`) round or truncate
  unpredictably - worth checking directly once deployed. **Configurable via
  `progressDisplayMode`** (default `"both"`) - set to `"fan"` to hide this
  one. Switching either mode automatically removes the tile(s) no longer in
  use rather than leaving an orphan behind.
- A **Speed changed notification** — sent whenever the print speed profile
  changes, whether triggered from HomeKit or externally (touchscreen/app),
  since both paths update the same tracked value. **Debounced**: right after
  you set a speed from HomeKit, reconciliation notifications are suppressed
  for 5 seconds (the printer's own status can briefly lag behind before
  catching up, which would otherwise misread as a genuine external change and
  fire a spurious "changed to X" notification mid-transition). After that
  window, exactly one check runs - if it settled on something other than
  what you asked for, that's a real correction and gets its own notification
  and a live slider update; if it matches, nothing further fires.
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
| Print failed/cancelled | ❌ Print failed |

## Live Activities (Lock Screen tile) instead of push notifications

Setting `useLiveActivity: true` replaces the Started/Progress/Finished push
notifications with a single **persistent, updating Lock Screen tile** instead
- Pingie's own pitch for this is literally "one tile instead of a stack of
notifications," which is exactly what it does here.

**Important: this needs a different credential than everything else in this
config, and Pingie has no group support for it at all.** Live Activities are
a per-*device* Pingie feature - confirmed directly from their API docs, the
`/live-activity/{id}` endpoint only accepts a device ID or a specific
`activityId`, no `GRP*` auto-detection the way the regular notification
endpoint has. **To show the tile on more than one phone, add one entry per
device to `liveActivityDevices`** - the plugin sends a separate update to
each device listed, achieving multi-device support itself even though
Pingie's own API has no native concept of it for this feature. Get each
device's ID and Token from the Notify! app's Devices tab on that device (not
the Group ID/Token used for regular pushes).

How it maps onto data we already track:
- `progress` (0-100) is exactly `mc_percent`
- `endsIn` (seconds from now) is exactly `mc_remaining_time × 60` - iOS ticks
  the countdown locally after that with no further requests, refreshed on
  each progress update to stay accurate over a multi-hour print
- `body` shows speed (with an emoji per profile: 🐢 Silent, 🚶 Standard,
  🏃 Sport, 🚀 Ludicrous), the print's material(s) (read from the sliced 3MF
  at print start, alongside the preview thumbnail fetch - one shared FTP
  download rather than two separate ones), and an estimated cost calculated
  from the printer's own time estimate - e.g. `🚀 Ludicrous · PLA · Est.
  £0.16`
- The tile starts the moment printing begins (even before a time estimate
  exists - it just shows 0% until `endsIn` populates on the next update),
  updates every `liveActivityUpdateIntervalPercent` (default 1%, decoupled
  from `progressNotificationIntervalPercent` - Live Activity updates are
  lightweight, so there's no real reason to throttle them the same way a
  burst of push notifications needs to be), and
  ends automatically at Finish (`status: "done"`, showing the total cost as
  the tile's final trailing text if filament/electricity pricing is
  configured) or at a failed/cancelled print (`status: "failed"`)
- **The tile itself now starts earlier than `RUNNING`** - at the moment
  `occupied` first becomes true, which (with the default `activeStates`
  including `PREPARE`) is right when heating/leveling begins, not once actual
  printing starts. This is specifically what makes the next point possible.
- **Bed/nozzle heating updates the tile's body** (`🌡️ Heating bed: 24°C →
  60°C`) instead of sending a separate push, since the tile now exists by the
  time these fire. Reverts to the standard body line on the next regular
  progress update. If you've customized `activeStates` to exclude `PREPARE`,
  the tile won't exist yet during heating for your setup, and this falls back
  to a regular push automatically - not a bug, just nothing to encapsulate
  into in that configuration.
- **A speed change triggers an immediate out-of-cycle update** (not waiting
  for the next 1% tick) - both `body` (new speed) and a fresh
  `requestFullState()` call to prompt the printer for an updated
  `mc_remaining_time` sooner, since a speed change can meaningfully shift how
  long is actually left. Applies whether the change came from HomeKit or was
  detected externally (touchscreen/app).
- **First layer check inspection also updates the tile's body** (`👁️
  Inspecting first layer`) instead of sending a separate push, while a print
  using the Live Activity is active - reverts to the standard body line on
  the next regular progress update.

**One thing still deliberately sends as a separate push even in Live
Activity mode, for an architectural reason rather than oversight: AMS
Auto-Dry** (enabled/disabled, started/stopped) - drying isn't tied to an
active print at all; it can run with the printer completely idle. Folding it
into a print's Live Activity would mean inconsistent behaviour depending on
unrelated print state, so it stays separate regardless of this setting.

**Pausing pushes an explicit `status: "paused"` update immediately, with a
real platform limitation worth knowing:** once `endsIn` is set, iOS ticks that
countdown down in real wall-clock time on its own, independent of whether we
send further updates - this is fundamental ActivityKit behaviour, not
something a plugin-side fix can prevent. So the tile's *status text* will
correctly say "Paused," but the *countdown number itself* will keep visually
ticking down through the pause regardless. On resume, a fresh `endsIn` is
pushed from the printer's current `mc_remaining_time`, correcting for
whatever drifted during the pause.

`liveActivitySymbol` (default `printer.fill`) and `liveActivityTint` (default
`#FF6600`) control the tile's icon and accent color. `liveActivityKeepForSeconds`
(default 300) controls how long the finished tile lingers before clearing -
Pingie's own docs specifically warn that forgetting to end a tile explicitly
leaves it stuck for up to 4 hours, which this plugin always does correctly on
your behalf.

**Filament cost and Electricity cost notifications still send as regular
pushes either way** - they're separate detail breakdowns that don't map
cleanly onto a single tile's content, so they're unaffected by this setting.

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
      "refreshIntervalSeconds": 0,
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

## Known-resolved: printer freezing/hanging

If you experienced the printer's screen/network stack becoming unresponsive
(motion sometimes continuing, sometimes stalling too) - **this was confirmed
resolved**, and the real root cause turned out to be **outside this plugin
entirely**: a camera.ui NVR configuration keeping a continuous RTSPS
connection open to the printer's camera 24/7 via `prebuffering: true`,
`videoanalysis.active: true`, and HomeKit Secure Video recording - all three
require constantly reading the live stream, not just when actually viewing
or recording. Disabling all three (`prebuffering: false`,
`videoanalysis.active: false`, and turning off HKSV for the camera in the
Home app) resolved it after sustained testing across multiple prints.

If you're hitting similar symptoms: check your camera.ui/NVR tool's recording
settings first, specifically anything that keeps the stream continuously
open rather than on-demand, before assuming it's this plugin or the printer
itself. This plugin's own MQTT traffic was investigated as a possible
contributor too (see `refreshIntervalSeconds`/reconnect backoff below) and
reducing it is still good practice on its own merits, but the camera
connection was the actual fix.

## How it works

- Subscribes to `device/<serial>/report` over MQTT/TLS (self-signed cert, hence
  `rejectUnauthorized: false` by default).
- On connect (and after every reconnect), publishes one `pushall` request to
  `device/<serial>/request` — Bambu printers otherwise only send *diffs* after
  the first message, so this establishes a complete baseline. After that, the
  printer's own continuous status pushes keep the plugin's view current -
  `refreshIntervalSeconds` (off/0 by default) only adds a *periodic* repeat of
  this request as extra insurance against a message silently going missing
  while the connection stays up the whole time, which is a rare edge case
  compared to an actual disconnect (already handled by the reconnect-triggered
  refresh). Not needed for normal operation; set a positive value only if
  you've actually seen fields go stale without a disconnect happening. Kept
  off by default as good minimal-traffic practice, even though the actual
  freeze culprit turned out to be camera.ui, not this - see "Known-resolved"
  above.
- Reconnects use **exponential backoff** (`reconnectDelaySeconds` doubling up
  to `reconnectMaxDelaySeconds`, default ceiling 5 minutes), not a constant
  retry rate. Sensible defensive practice regardless of root cause: if a
  printer-side hang involves any kind of resource contention, retrying every
  few seconds indefinitely could plausibly add load to something already
  struggling rather than helping - backing off during an extended outage is
  the safer default either way.
  default regardless of whether that's the actual mechanism.
- **Optionally** (`enableNetworkPresenceCheck`, off by default), reconnects
  can be ping-gated instead: check every `presenceCheckIntervalSeconds`
  (default 30s) whether the printer answers a basic network ping at all
  before ever attempting a real MQTT/TLS handshake, skipping the attempt
  entirely if it doesn't. This targets a *different* failure mode than the
  backoff above - a printer that's genuinely off the network (confirmed real
  in community reports of WiFi dropping out) rather than an app-layer hang
  that might still respond to ping. **Fails open**: if the ping check itself
  doesn't work in your environment (a real risk - some minimal Docker images
  lack a working `ping` binary or the permissions to use it), it falls back
  to reconnecting normally rather than silently refusing to ever reconnect
  again because of an environment limitation.
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

## Print preview image in notifications (rendered from the sliced file)

Setting `includePrintPreviewImage: true` attaches the slicer-rendered plate
preview - the same thumbnail image your printer's touchscreen shows when
browsing files - as the notification icon. This is extracted directly from
the sliced `.3mf` file's embedded `Metadata/plate_N_small.png` (falling back
to the full-size `plate_N.png` if no small version exists) via the **same
FTP connection already used for filament weight parsing** - not the camera,
so none of the connection-contention concerns from the camera snapshot
feature apply here. Fetched once per print (cached and reused across every
notification for that print, not re-fetched each time) and uploaded to the
same GitHub repo used for camera snapshots, via a separate file path so the
two features don't collide if both are ever enabled.

**Preferred over the camera snapshot** if both `includePrintPreviewImage` and
`includeCameraSnapshot` are enabled - falls back to the camera snapshot (or
plain text) only if the preview thumbnail isn't available for some reason
(e.g. no `<filament>`/preview data in this particular file).

**Not usable with Live Activities** - that API only supports an SF Symbol
name for the tile's icon, not a custom image URL, so this setting has no
effect while `useLiveActivity: true`.

Verified end-to-end against a real sliced file: the exact regex used to find
the thumbnail (`Metadata/plate_\d+_small\.png`) correctly matched
`Metadata/plate_1_small.png` in a real Bambu Studio export, not just a
plausible-looking guess.

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

Configure prices via `filamentPrices` in the Homebridge UI - a real add/edit
list (Material + Price per kg per row), no JSON editing required. Verified
end-to-end against a real sliced file: parsed weight matched the file's own
declared total exactly. A material not added to the list still shows its
weight in the breakdown, just with "price not set" instead of a cost, and is
excluded from the total (noted as "some materials unpriced" rather than
silently treated as free). Material names must match exactly what's in your
sliced files (case-sensitive) - `PLA`, `PETG`, `ABS`, or a composite like
`PLA-CF` if that's what you print.

**One real uncertainty remaining** (the XML schema itself is now confirmed,
see below):
- **The file path.** This assumes the project sits at `/cache/<subtask_name>.3mf`
  (the convention when a print is sent from Bambu Studio), falling back to
  root if not found there. If your prints are started a different way, this
  might not find the file - check the log for "Couldn't find the project file"
  and the exact paths it tried.

**The XML schema itself is confirmed, not just assumed** - verified against a
real sliced 3MF file's `Metadata/slice_info.config`: `type="PLA"` and
`used_g="124.29"` style attributes on `<filament>` elements, parsed weight
summed to exactly the file's own declared plate total (126.48g). The earlier
uncertainty here has been resolved; the code hasn't changed, just the
confidence level.

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
  but setting `enableRequestTopicSniffing: true` makes the plugin watch the
  `/request` topic for commands sent by *other* clients (Bambu Studio, Handy,
  the touchscreen) on the same connection - press the native "Dry" button in
  Bambu Studio's Device page and check the Homebridge log for a line like
  `Observed an AMS drying command from another client - ams_id=131`, no
  separate MQTT tool needed. **This is off by default to keep MQTT traffic
  minimal** - turn it on temporarily while hunting for the value, then back
  off once found.
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
