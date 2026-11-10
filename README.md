# loudness-check-mcp

[![CI](https://github.com/anshumanofficial2002-cpu/loudness-check-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/anshumanofficial2002-cpu/loudness-check-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-black)](https://modelcontextprotocol.io)

**"Is my mix too quiet for YouTube?" — answered with real LUFS numbers, then fixed.**

`loudness-check-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that measures audio loudness the way platforms and broadcasters do (EBU R128 / ITU-R BS.1770 via ffmpeg), explains what YouTube, Spotify, Apple, podcast apps and broadcasters will do with your file, and writes a corrected copy — an exact gain change when that's enough, two-pass `loudnorm` when it isn't. It also finds dead air, clipping and sudden loudness jumps — with timestamps.

Works on audio files and on the audio track of videos. Everything runs locally.

```
You:    Check ep42_final.wav for podcast and YouTube.
Claude: Integrated -11.2 LUFS, true peak +0.4 dBTP.
        ⚠️ Podcast: 4.8 LU louder than -16. ⚠️ YouTube will turn it down ~2.8 dB,
        and the true peak above 0 dBTP will distort after AAC encoding.
        Want a -16 LUFS / -1 dBTP version?
You:    Yes, as MP3.
Claude: A plain -4.8 dB gain gets there, so that's all I applied (dynamics untouched).
        Saved ep42_final_podcast.mp3 — now -16.0 LUFS, -4.4 dBTP.
```

---

## Tools

| Tool | What it does |
| --- | --- |
| `measure_loudness` | Integrated loudness (LUFS), true peak (dBTP), loudness range (LRA), max momentary / short-term, sample peak, RMS, noise floor, DC offset. Optional target comparison. |
| `check_loudness_targets` | Compares against YouTube, Spotify, Apple Music, Tidal, social, podcast, EBU R128 and ATSC A/85 and explains what each platform will do. Optional **ACX audiobook** check (RMS, peak, noise floor). |
| `normalize_loudness` | Hits a preset or custom target. Applies an **exact gain change** when that keeps true peak under the ceiling (your mix's dynamics are untouched); otherwise uses two-pass dynamic `loudnorm` and tells you why. Copies the video stream untouched for video files and re-measures the result. |
| `loudness_timeline` | Loudness per window (default 5 s): loudest/quietest sections and sudden jumps. CSV export. |
| `detect_silence` | Silent stretches with timestamps, totals, and padded **keep segments** for planning jump cuts. CSV export. |
| `detect_clipping` | Flat-topped clipping, true-peak overs, and the time ranges where peaks cross a threshold. |
| `list_targets` | All targets and how each platform behaves. |
| `check_setup` | Confirms ffmpeg and the required filters (ebur128, loudnorm, astats, silencedetect). |

### Targets

| id | Target | Integrated | True peak | Platform behaviour |
| --- | --- | --- | --- | --- |
| `youtube` | YouTube | -14 LUFS | ≤ -1 dBTP | Turns louder videos down; doesn't turn quiet ones up |
| `spotify` | Spotify | -14 LUFS | ≤ -1 dBTP | Normalizes both ways (up only as far as peaks allow) |
| `apple_music` | Apple Music | -16 LUFS | ≤ -1 dBTP | Sound Check |
| `tidal` | Tidal | -14 LUFS | ≤ -1 dBTP | Normalizes down |
| `social` | Instagram / TikTok / Shorts | -14 LUFS | ≤ -1 dBTP | No published spec; common practice |
| `podcast` | Podcast (stereo) | -16 LUFS | ≤ -1 dBTP | Widely used podcast target (≈ -19 for mono) |
| `ebu_r128` | EBU R128 broadcast | -23 LUFS ±0.5 | ≤ -1 dBTP | Delivery spec |
| `atsc_a85` | ATSC A/85 (US broadcast) | -24 LKFS ±2 | ≤ -2 dBTP | Delivery spec |
| `include_acx` | ACX / Audible | RMS -23 to -18 dB | peak ≤ -3 dB | Noise floor ≤ -60 dB |

> Streaming targets are the commonly cited reference levels. Platforms tweak their normalization over time; broadcast specs are formal standards.

---

## Requirements

- **Node.js 20+**
- **ffmpeg** with the `ebur128`, `loudnorm`, `astats` and `silencedetect` filters (all standard builds include them)
  - macOS: `brew install ffmpeg` · Ubuntu: `sudo apt install ffmpeg` · Windows: `winget install ffmpeg`

The server finds ffmpeg via `FFMPEG_PATH`, then `PATH`, then common folders like `/opt/homebrew/bin` (Claude Desktop on macOS starts servers with a minimal `PATH`).

## Install

### Claude Desktop

**Settings → Developer → Edit Config**:

```json
{
  "mcpServers": {
    "loudness-check": {
      "command": "npx",
      "args": ["-y", "github:anshumanofficial2002-cpu/loudness-check-mcp"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add loudness-check -- npx -y github:anshumanofficial2002-cpu/loudness-check-mcp
```

### Cursor / Windsurf / VS Code / other clients

```json
{
  "loudness-check": {
    "command": "npx",
    "args": ["-y", "github:anshumanofficial2002-cpu/loudness-check-mcp"]
  }
}
```

### From source

```sh
git clone https://github.com/anshumanofficial2002-cpu/loudness-check-mcp.git
cd loudness-check-mcp && npm install && npm run build
# point your client at: node /absolute/path/to/loudness-check-mcp/dist/index.js
```

---

## Example prompts

- "How loud is `~/Music/bounce_v7.wav`? Is it ready for Spotify and YouTube?"
- "Normalize `ep12.mp3` to podcast loudness and save it as `ep12_master.mp3`."
- "My reel `final.mp4` sounds quiet next to other posts. Fix the audio to -14 LUFS without re-encoding the video."
- "Where's the loud part in this interview? Give me a 10-second timeline."
- "Find every pause longer than 0.8 s in `raw_vo.wav` and give me the segments to keep for jump cuts."
- "Is `voiceover.wav` clipping anywhere?"
- "Does `chapter_03.wav` pass ACX for Audible?"
- "Make an EBU R128 broadcast version of `promo.mov`."

---

## Tool reference

Shared params on analysis tools: `path`, `start` (seconds or `HH:MM:SS`), `duration` (seconds), `audio_stream` (default 0).

### `measure_loudness`
`targets` (optional list of target ids).

### `check_loudness_targets`
`targets` (default `["youtube","spotify","social","podcast"]`), `include_acx` (false).

### `normalize_loudness`

| Param | Default | Notes |
| --- | --- | --- |
| `output_path` | `<name>_<target>.<ext>` next to source | Extension picks the codec: `.wav` 24-bit PCM, `.aiff`, `.flac`, `.mp3` 320 kbps, `.m4a` AAC 256 kbps, `.opus`; `.mp4/.mov/.mkv` keep the video stream (copied) with AAC audio. |
| `target` | `youtube` | Any target id. |
| `integrated_lufs` | — | Custom target (overrides `target`). |
| `true_peak_dbtp` | target's ceiling | Custom ceiling. |
| `lra_lu` | 11 | Target loudness range in dynamic mode. |
| `linear` | true | Prefer an exact gain change. If that would push true peak over the ceiling, dynamic loudnorm is used and the result explains what to change to stay linear. Set `false` to always use dynamic loudnorm. |
| `sample_rate` | source rate | Output sample rate (loudnorm processes at 192 kHz internally; output is resampled to this). |
| `dry_run` | false | Measure, pick the mode, and return the command without writing. |
| `overwrite` | false | |

### `loudness_timeline`
`window_seconds` (5), `jump_lu` (6 — flags jumps in max momentary loudness between windows), `max_rows` (120), `csv_output_path`, `overwrite`.

### `detect_silence`
`noise_db` (-45; raise to -35 for noisy rooms), `min_silence_seconds` (0.6), `keep_padding_seconds` (0.12), `include_keep_segments` (true), `max_rows` (100), `csv_output_path`, `overwrite`.

### `detect_clipping`
`threshold_dbtp` (-1), `max_rows` (50). Verdict `fail` = flat-topped samples at full scale; `warn` = true peak above 0 dBTP or peaks above the threshold.

---

## How it measures

- **Integrated loudness, LRA, true peak, momentary/short-term:** ffmpeg `ebur128` with `peak=true` (ITU-R BS.1770-4 gating, 4× oversampled true peak).
- **Sample peak, RMS, noise floor, DC offset, flat factor:** ffmpeg `astats`, in the same pass via `asplit`.
- **Normalization:** `loudnorm` pass 1 measures the file. If `target − measured` dB of gain keeps the true peak under the ceiling, that exact gain is applied with ffmpeg's `volume` filter (true linear normalization, works on clips of any length). Otherwise pass 2 runs `loudnorm` in dynamic mode with the measured values, which is far more accurate than single-pass. Lossy encoders (MP3/AAC) can add a few tenths of a dB of true peak; the result flags it.
- **Silence:** `silencedetect`.

## Safety

- ffmpeg runs via `spawn` with argument arrays — no shell.
- Outputs are refused if they already exist unless `overwrite: true`, and can't overwrite the input.
- No network access, no telemetry.

## Development

```sh
npm install
npm run build
npm test          # parser unit tests + end-to-end tests that generate audio with ffmpeg
npm run inspect   # MCP Inspector
```

`dist/` is committed so `npx github:…` works without a build; CI verifies it matches `src/`.

## Related servers

- [video-probe-mcp](https://github.com/anshumanofficial2002-cpu/video-probe-mcp) — inspect and conform video for each platform
- [caption-forge-mcp](https://github.com/anshumanofficial2002-cpu/caption-forge-mcp) — SRT/VTT/ASS conversion, timing, linting and reel-style captions
- [loudness-check-mcp](https://github.com/anshumanofficial2002-cpu/loudness-check-mcp) — LUFS, true peak, normalization, silence and clipping
- [frame-grab-mcp](https://github.com/anshumanofficial2002-cpu/frame-grab-mcp) — frames, contact sheets, scene cuts and thumbnails your AI can see
- [script-timer-mcp](https://github.com/anshumanofficial2002-cpu/script-timer-mcp) — time, trim and format scripts for short-form video

## License

[MIT](LICENSE) © 2026 Anshuman
