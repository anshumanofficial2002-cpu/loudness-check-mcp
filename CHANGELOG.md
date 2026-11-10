# Changelog

## 1.0.0 — 2026-11-11

First release.

- `measure_loudness` (EBU R128 integrated, LRA, true peak, momentary/short-term max, sample peak, RMS, noise floor, DC offset)
- `check_loudness_targets` for YouTube, Spotify, Apple Music, Tidal, social, podcast, EBU R128, ATSC A/85, plus ACX audiobook rules
- `normalize_loudness` with two-pass linear loudnorm, video passthrough and re-measure
- `loudness_timeline`, `detect_silence` (with keep segments), `detect_clipping`, `list_targets`
