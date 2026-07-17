# Lilypad v1.0 — Release Notes

**Your Mac, in your pocket.** Lilypad turns an iPhone into a live, secure
remote control for a Mac: see the screen in real time, tap to click, pinch to
zoom, type with the phone keyboard — with nothing able to connect unless a
human clicks **Approve** on the Mac itself.

## Highlights

- **60-second pairing.** Click the bubble on the Mac, scan the QR with the
  phone, approve — you're controlling the Mac in seconds. Every code works
  exactly once and dies in a minute.
- **Real streaming, engineered for latency.** Native ScreenCaptureKit capture
  and VideoToolbox hardware H.264, ~1s GOP, two-frame send queue, adaptive
  1–10 Mbps bitrate that recovers from bad estimates in seconds — smooth on
  LAN, architected (WebRTC + TURN) for the open internet.
- **Touch that feels native.** Tap, double-tap, drag, long-press
  right-click, two-finger scroll — plus a 6× pinch-zoom viewport, a zoom
  lock for photo-style panning, and full-bleed landscape with a collapsible
  control tray.
- **Type like it's local.** The phone keyboard (autocorrect included) types
  straight into the Mac; clipboard syncs both ways; sticky ⌘⇧⌥⌃ chips arm
  modifier-clicks.
- **Sessions that survive real life.** Auto-lock, app-switching, network
  blips, backend deploys: keep-awake on both ends, seat-holding grace
  windows, ICE-restart recovery, and room resurrection keep the session
  alive — or bring it back — without re-pairing.
- **Security as a feature.** Approval is mandatory and visible; input scopes
  are enforced at the OS-injection boundary; TURN credentials are per-session
  and time-limited; every security event is audit-logged; production boots
  refuse unsafe configuration outright.

## By the numbers

- 538 automated tests across four suites (backend 221, mobile 153, desktop
  164), all green.
- 20 signaling message types + 10 input event kinds, schema-validated on
  every hop, with a drift test pinning the TypeScript and Rust definitions
  to each other.
- End-to-end verified on physical hardware: iPhone 13 ↔ MacBook, including
  double-click semantics, background/foreground recovery, and multi-hour
  stability fixes discovered on-device.

## Known limitations (v1.0)

- macOS desktop + iOS viewer; Windows desktop and Android are
  compile-scaffolded, not shipped.
- No user accounts yet — possession of the QR plus desktop approval is the
  trust model (accounts/trusted devices land in M5).
- Internet (TURN-relayed) operation requires deploying the backend + coturn;
  the shipped configuration is LAN-first.
- Unsigned dev builds re-prompt macOS permissions after rebuilds; a signed,
  notarized bundle is part of the distribution track.
