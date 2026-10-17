# Troubleshooting

Common problems with the bridge, and what to check first. Option names are given as **add-on
option / Docker env var**. If your problem isn't here, see
[Reporting a problem](#reporting-a-problem) at the end.

- [A battery camera's stream keeps restarting, or its battery drains fast](#a-battery-cameras-stream-keeps-restarting-or-its-battery-drains-fast)
- [A watched battery-camera stream drops about every minute](#a-watched-battery-camera-stream-drops-about-every-minute)
- [A mains camera's stream stops after about 5 minutes](#a-mains-cameras-stream-stops-after-about-5-minutes)
- [A change reports OK but the camera ignores it, or live view never starts](#a-change-reports-ok-but-the-camera-ignores-it-or-live-view-never-starts)
- [The bridge or the eufy app keeps getting logged out](#the-bridge-or-the-eufy-app-keeps-getting-logged-out)
- [Login works but no devices show up](#login-works-but-no-devices-show-up)
- [eufy keeps emailing verification codes](#eufy-keeps-emailing-verification-codes)
- [The bridge is connected but no events arrive](#the-bridge-is-connected-but-no-events-arrive)
- [Live view takes a while to start on a battery camera](#live-view-takes-a-while-to-start-on-a-battery-camera)

## A battery camera's stream keeps restarting, or its battery drains fast

Check Home Assistant's **Preload camera stream** setting on that camera entity (Settings → Devices &
services → Entities → the camera → ⚙ settings). With it on, Home Assistant keeps the stream open
permanently and reopens it whenever it closes, so a battery camera wakes up over and over. Turn it
off for battery cameras. The next release of the integration raises a Repairs warning, with a
one-click fix, when a battery camera has it on.

## A watched battery-camera stream drops about every minute

The SDK limits how long a battery camera may stream continuously (45 s plus a 10 s grace by
default). Older bridges could not extend that limit through `/stream`, so an open stream ended
roughly every 55 s: the picture froze, the camera's _streaming_ sensor went off, and only reopening
the view brought it back. Now the bridge extends the limit while go2rtc still lists a
viewer, up to `stream_battery_max_ms` / `STREAM_BATTERY_MAX_MS` (10 min by default). The log shows
`battery budget extended` each time. Mains cameras aren't affected.

## The first live view of a 4G camera takes half a minute

A battery camera on a mobile connection wakes within a few seconds, but the cloud goes on handing
out the address it had before it slept for another ~30 s, and no P2P connection can be made to
that address. The log shows `camera not reachable yet after …s — still waiting for it` meanwhile;
the viewer sees the last live picture (or a stand-in) until the camera answers. This wait is on the
camera's and the carrier's side.

## A mains camera's stream stops after about 5 minutes

Update to bridge **0.5.0** (add-on **0.6.0**) or later. Older versions also applied the idle
auto-off (`stream_idle_ms` / `STREAM_IDLE_MS`) to mains-powered cameras; since 0.5.0 it applies to
battery cameras only. If you set `STREAM_IDLE_MS=0` / `RTSP_IDLE_OFF_MS=0` as a workaround, you can
remove it.

## A change reports OK but the camera ignores it, or live view never starts

This mostly affects **standalone** cameras (not attached to a HomeBase). Typical signs in a `debug`
log:

- `level2-unavailable reason=grace-elapsed` after the camera connects;
- an arming or settings change logs `OK`, but the value in Home Assistant never changes;
- live view logs `warm-timeout at awaiting-first-frame` although the camera answered.

The camera never sets up the encryption key the bridge needs for protected commands, so it
acknowledges the command and then ignores it. This is being investigated in
[eufy-sdk#325](https://github.com/mega-yfue/eufy-sdk/issues/325). The accounts affected so far
all have **Local Advanced Encryption** turned on (eufy app → Settings → Security → Media Content
Encryption), so that setting is the main suspect, but this isn't confirmed yet. If you see this,
please add your camera model and whether that setting is on to the issue.

## The bridge or the eufy app keeps getting logged out

eufy allows **one active session per account**. When the phone app logs in with the same account,
it can bump the bridge's session; the bridge then logs in again and eufy may ask for 2FA. Use a
**dedicated eufy account** for Home Assistant, shared from your main account in the eufy app (see
the add-on's "Use a dedicated eufy account" section), and run only one bridge per account.

## Login works but no devices show up

- **Country:** check `country` / `EUFY_COUNTRY` is the country the eufy account was registered in.
  It decides which eufy region the bridge talks to; the wrong one gives an empty device list.
- **Stored session:** the bridge reuses its saved login on restart, so after changing the country,
  remove it to force a fresh login:
  - add-on: uninstall it and choose to **delete its data**, then reinstall;
  - Docker: stop the container and delete `.eufy-session.json` from the data volume (`EUFY_SESSION`,
    default `/app/data/.eufy-session.json`).
- **Shared account:** a shared account only sees the devices the owner shared with it. Check the
  share in the owner's eufy app.

## eufy keeps emailing verification codes

If the bridge's session was bumped and the automatic re-login needs 2FA, finish the verification
from Home Assistant: the integration shows a re-authentication prompt (Settings → Devices &
services). Using a dedicated account (see above) avoids most of these. An SDK fix that stops
repeated automatic re-login attempts is in
[eufy-sdk#432](https://github.com/mega-yfue/eufy-sdk/pull/432).

## The bridge is connected but no events arrive

The bridge receives events through eufy's push service, so the host needs working DNS and outbound
access to Google's push servers (`mtalk.google.com`). VPN or DNS overlays on the host can break this
while everything else still looks connected; one confirmed case was Tailscale MagicDNS. Look for
`EAI_AGAIN` or push reconnect errors in the log. To confirm, run the bridge (or any eufy client) on
another machine on the same LAN: if events arrive there, the problem is the host's network.

## Live view takes a while to start on a battery camera

A battery camera sleeps, and live view first has to wake it and open a session. Turn on `prewarm` /
`BRIDGE_PREWARM=1` to open the session as soon as a doorbell, person, pet or package event arrives,
so a live view opened right after an event starts much faster. It holds the camera's radio on for
about 28 s per event, which costs some battery.

## Reporting a problem

Please include:

1. **Versions:** bridge (or add-on) and integration.
2. **Setup:** camera model(s), whether each camera is standalone or attached to a HomeBase, and
   whether the bridge's account is the owner or a shared account.
3. **Bridge log:** turn on `debug` (plus `debug_p2p` for connection or stream problems), restart,
   reproduce once, then copy the log. Docker: `BRIDGE_DEBUG=1` / `BRIDGE_DEBUG_P2P=1`.
4. **Diagnostics:** Settings → Devices & services → eufy-sdk → ⋮ → **Download diagnostics**.

Remove your email address, passwords and public IPs before posting. Serial numbers help match log
lines, but you can replace them consistently (for example `CAMERA-1`) if you prefer.

Open issues at [ha-eufy-sdk-bridge/issues](https://github.com/mega-yfue/ha-eufy-sdk-bridge/issues).
