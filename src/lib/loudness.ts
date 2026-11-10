/** Loudness measurement and analysis on top of ffmpeg's ebur128, astats, loudnorm and silencedetect. */
import path from "node:path";
import { formatTimestamp, runOrThrow } from "./ffmpeg.js";

export interface Range {
  start?: number;
  duration?: number;
}

function inputArgs(file: string, r: Range): string[] {
  const a: string[] = [];
  if (r.start !== undefined) a.push("-ss", String(r.start));
  a.push("-i", file);
  if (r.duration !== undefined) a.push("-t", String(r.duration));
  return a;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  if (/^-?inf$/i.test(s.trim())) return s.trim().startsWith("-") ? -Infinity : Infinity;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export interface Frame {
  t: number;
  momentary: number;
  shortTerm: number;
  /** Frame true peak (max over channels), dBFS. */
  ftpk: number | null;
}

export interface Measurement {
  integrated_lufs: number | null;
  loudness_range_lu: number | null;
  true_peak_dbtp: number | null;
  integrated_threshold_lufs: number | null;
  lra_low_lufs: number | null;
  lra_high_lufs: number | null;
  max_momentary_lufs: number | null;
  max_short_term_lufs: number | null;
  sample_peak_dbfs: number | null;
  rms_dbfs: number | null;
  noise_floor_dbfs: number | null;
  dc_offset: number | null;
  flat_factor: number | null;
  duration_seconds: number | null;
  frames: Frame[];
}

const FRAME_RE = /t:\s*([\d.]+)\s+TARGET:[-\d.]+ LUFS\s+M:\s*([-\d.]+)\s+S:\s*([-\d.]+)\s+I:.*?(?:FTPK:\s*([-\d.\s]+?)\s*dBFS)?/;

export function parseEbur128(stderr: string): Omit<Measurement, "sample_peak_dbfs" | "rms_dbfs" | "noise_floor_dbfs" | "dc_offset" | "flat_factor" | "duration_seconds"> {
  const frames: Frame[] = [];
  for (const line of stderr.split("\n")) {
    if (!line.includes("TARGET:")) continue;
    const m = line.match(FRAME_RE);
    if (!m) continue;
    const ftpkVals = (line.match(/FTPK:\s*([-\d.\sinf]+?)\s*dBFS/)?.[1] ?? "")
      .trim()
      .split(/\s+/)
      .filter((v) => /^-?\d/.test(v))
      .map(Number)
      .filter(Number.isFinite);
    frames.push({ t: Number(m[1]), momentary: Number(m[2]), shortTerm: Number(m[3]), ftpk: ftpkVals.length ? Math.max(...ftpkVals) : null });
  }
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const grab = (re: RegExp) => num(summary.match(re)?.[1]);
  const valid = (v: number) => v > -70;
  const ms = frames.map((f) => f.momentary).filter(valid);
  const ss = frames.map((f) => f.shortTerm).filter(valid);
  return {
    integrated_lufs: grab(/I:\s*([-\d.]+) LUFS/),
    integrated_threshold_lufs: grab(/Integrated loudness:[\s\S]*?Threshold:\s*([-\d.]+) LUFS/),
    loudness_range_lu: grab(/LRA:\s*([-\d.]+) LU/),
    lra_low_lufs: grab(/LRA low:\s*([-\d.]+) LUFS/),
    lra_high_lufs: grab(/LRA high:\s*([-\d.]+) LUFS/),
    true_peak_dbtp: grab(/True peak:\s*\n?\s*Peak:\s*([-\d.inf]+) dBFS/),
    max_momentary_lufs: ms.length ? Math.max(...ms) : null,
    max_short_term_lufs: ss.length ? Math.max(...ss) : null,
    frames,
  };
}

export function parseAstats(stderr: string) {
  const overall = stderr.slice(stderr.lastIndexOf("Overall"));
  const get = (label: string) => num(overall.match(new RegExp(`${label}:\\s*([-\\d.e+inf]+)`, "i"))?.[1]);
  return {
    sample_peak_dbfs: get("Peak level dB"),
    rms_dbfs: get("RMS level dB"),
    noise_floor_dbfs: get("Noise floor dB"),
    dc_offset: get("DC offset"),
    flat_factor: get("Flat factor"),
    samples: get("Number of samples"),
  };
}

function durationFrom(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export async function measure(file: string, r: Range = {}, audioStream = 0): Promise<Measurement> {
  const args = [
    "-hide_banner", "-nostats", "-loglevel", "verbose",
    ...inputArgs(file, r),
    "-filter_complex", `[0:a:${audioStream}]asplit=2[a][b];[a]ebur128=peak=true[ao];[b]astats[bo]`,
    "-map", "[ao]", "-map", "[bo]", "-f", "null", "-",
  ];
  let res;
  try {
    res = await runOrThrow("ffmpeg", args, { timeoutMs: 30 * 60 * 1000 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/matches no streams|Stream specifier/i.test(msg)) throw new Error(`No audio stream #${audioStream} in ${path.basename(file)}.`);
    throw e;
  }
  const eb = parseEbur128(res.stderr);
  const as = parseAstats(res.stderr);
  const dur = r.duration ?? (durationFrom(res.stderr) !== null ? durationFrom(res.stderr)! - (r.start ?? 0) : null);
  return { ...eb, ...as, duration_seconds: dur };
}

/* ---------------------------------------------------------------- targets */

export interface Target {
  id: string;
  name: string;
  integrated: number;
  tolerance: number;
  max_true_peak: number;
  behaviour: string;
  /** "up_and_down" platforms raise quiet content (limited by peaks); "down_only" only turn loud content down. */
  normalizes: "down_only" | "up_and_down" | "none";
}

export const TARGETS: Record<string, Target> = {
  youtube: { id: "youtube", name: "YouTube", integrated: -14, tolerance: 1, max_true_peak: -1, normalizes: "down_only", behaviour: "Turns louder videos down to about -14 LUFS; does not turn quieter ones up." },
  spotify: { id: "spotify", name: "Spotify", integrated: -14, tolerance: 1, max_true_peak: -1, normalizes: "up_and_down", behaviour: "Normalizes to -14 LUFS by default; quiet tracks are raised only as far as their peaks allow." },
  apple_music: { id: "apple_music", name: "Apple Music", integrated: -16, tolerance: 1, max_true_peak: -1, normalizes: "up_and_down", behaviour: "Sound Check targets about -16 LUFS." },
  tidal: { id: "tidal", name: "Tidal", integrated: -14, tolerance: 1, max_true_peak: -1, normalizes: "down_only", behaviour: "Normalizes to about -14 LUFS." },
  social: { id: "social", name: "Instagram / TikTok / Shorts", integrated: -14, tolerance: 1.5, max_true_peak: -1, normalizes: "none", behaviour: "No published spec. -14 LUFS / -1 dBTP is common practice so clips sit level with music and other posts." },
  podcast: { id: "podcast", name: "Podcast (stereo)", integrated: -16, tolerance: 1, max_true_peak: -1, normalizes: "none", behaviour: "-16 LUFS stereo (≈ -19 mono) is the widely used podcast target, including Apple's guidance." },
  ebu_r128: { id: "ebu_r128", name: "EBU R128 broadcast", integrated: -23, tolerance: 0.5, max_true_peak: -1, normalizes: "none", behaviour: "European broadcast delivery: -23 LUFS ±0.5, true peak ≤ -1 dBTP." },
  atsc_a85: { id: "atsc_a85", name: "ATSC A/85 (US broadcast)", integrated: -24, tolerance: 2, max_true_peak: -2, normalizes: "none", behaviour: "US broadcast delivery: -24 LKFS ±2, true peak ≤ -2 dBTP." },
};

export type Verdict = "pass" | "warn" | "fail";

export interface TargetCheck {
  target: string;
  name: string;
  verdict: Verdict;
  integrated_lufs: number | null;
  target_lufs: number;
  delta_lu: number | null;
  true_peak_dbtp: number | null;
  max_true_peak: number;
  what_happens: string;
  fix: string | null;
}

export function checkTarget(m: Measurement, t: Target): TargetCheck {
  const i = m.integrated_lufs;
  const tp = m.true_peak_dbtp;
  const delta = i === null ? null : +(i - t.integrated).toFixed(1);
  const peakOver = tp !== null && tp > t.max_true_peak;
  const off = delta !== null && Math.abs(delta) > t.tolerance;
  let verdict: Verdict = off || peakOver ? "warn" : "pass";
  if (t.normalizes === "none" && delta !== null && Math.abs(delta) > t.tolerance * 3) verdict = "fail";
  if ((t.id === "ebu_r128" || t.id === "atsc_a85") && (off || peakOver)) verdict = "fail";

  let happens = "";
  if (delta === null) happens = "Could not measure integrated loudness (silent or too short?).";
  else if (t.normalizes === "down_only") happens = delta > 0 ? `${t.name} will turn it down ~${delta} dB.` : delta < -t.tolerance ? `Will play ${Math.abs(delta)} dB quieter than other content (not turned up).` : "Sits right at the platform level.";
  else if (t.normalizes === "up_and_down") happens = delta > 0 ? `Will be turned down ~${delta} dB.` : delta < -t.tolerance ? `Will be turned up at most to where peaks allow; may still play quieter.` : "Sits right at the platform level.";
  else happens = delta > t.tolerance ? `${delta} LU louder than the target.` : delta < -t.tolerance ? `${Math.abs(delta)} LU quieter than the target.` : "On target.";
  if (peakOver) happens += ` True peak ${tp} dBTP is above ${t.max_true_peak} dBTP — risk of distortion after lossy encoding.`;

  const fix = verdict === "pass" ? null : `normalize_loudness with target "${t.id}" (${t.integrated} LUFS, ${t.max_true_peak} dBTP).`;
  return { target: t.id, name: t.name, verdict, integrated_lufs: i, target_lufs: t.integrated, delta_lu: delta, true_peak_dbtp: tp, max_true_peak: t.max_true_peak, what_happens: happens, fix };
}

/** ACX (Audible) audiobook rules are RMS-based, not LUFS. */
export function checkAcx(m: Measurement) {
  const rms = m.rms_dbfs;
  const peak = m.sample_peak_dbfs;
  const floor = m.noise_floor_dbfs;
  const rows = [
    { check: "RMS level", actual: rms, expected: "-23 to -18 dB", pass: rms !== null && rms >= -23 && rms <= -18 },
    { check: "Peak", actual: peak, expected: "≤ -3 dB", pass: peak !== null && peak <= -3 },
    { check: "Noise floor", actual: floor, expected: "≤ -60 dB", pass: floor !== null && floor <= -60 },
  ];
  return { verdict: (rows.every((r) => r.pass) ? "pass" : "fail") as Verdict, rows, note: "Noise floor from astats is the quietest sustained level in the whole file; measure a room-tone section for a stricter check." };
}

/* ---------------------------------------------------------------- timeline */

export interface Window {
  start: number;
  end: number;
  max_momentary: number | null;
  max_short_term: number | null;
  max_true_peak: number | null;
}

export function windows(frames: Frame[], size: number, offset = 0): Window[] {
  const out: Window[] = [];
  if (!frames.length) return out;
  const last = frames[frames.length - 1].t;
  for (let s = 0; s < last; s += size) {
    const fs = frames.filter((f) => f.t > s && f.t <= s + size);
    const max = (vals: number[]) => (vals.length ? +Math.max(...vals).toFixed(1) : null);
    out.push({
      start: +(s + offset).toFixed(2),
      end: +(Math.min(s + size, last) + offset).toFixed(2),
      max_momentary: max(fs.map((f) => f.momentary).filter((v) => v > -70)),
      max_short_term: max(fs.map((f) => f.shortTerm).filter((v) => v > -70)),
      max_true_peak: max(fs.map((f) => f.ftpk).filter((v): v is number => v !== null && Number.isFinite(v))),
    });
  }
  return out;
}

/** Merge frames whose peak is above a threshold into time ranges. */
export function peakRanges(frames: Frame[], threshold: number, offset = 0): { start: number; end: number; peak: number }[] {
  const out: { start: number; end: number; peak: number }[] = [];
  let cur: { start: number; end: number; peak: number } | null = null;
  for (const f of frames) {
    if (f.ftpk !== null && f.ftpk >= threshold) {
      const s = +(f.t - 0.1 + offset).toFixed(2);
      if (cur && s - cur.end <= 0.15) {
        cur.end = +(f.t + offset).toFixed(2);
        cur.peak = Math.max(cur.peak, f.ftpk);
      } else {
        if (cur) out.push(cur);
        cur = { start: Math.max(0, s), end: +(f.t + offset).toFixed(2), peak: f.ftpk };
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* ---------------------------------------------------------------- silence */

export interface Silence {
  start: number;
  end: number;
  duration: number;
}

export function parseSilence(stderr: string, totalDuration: number | null): Silence[] {
  const out: Silence[] = [];
  let start: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
    if (e && start !== null) {
      out.push({ start: +start.toFixed(3), end: +Number(e[1]).toFixed(3), duration: +Number(e[2]).toFixed(3) });
      start = null;
    }
  }
  if (start !== null && totalDuration !== null && totalDuration > start) {
    out.push({ start: +start.toFixed(3), end: +totalDuration.toFixed(3), duration: +(totalDuration - start).toFixed(3) });
  }
  return out;
}

export async function detectSilence(file: string, noiseDb: number, minDuration: number, r: Range = {}, audioStream = 0) {
  const res = await runOrThrow(
    "ffmpeg",
    ["-hide_banner", "-nostats", ...inputArgs(file, r), "-map", `0:a:${audioStream}`, "-af", `silencedetect=n=${noiseDb}dB:d=${minDuration}`, "-f", "null", "-"],
    { timeoutMs: 30 * 60 * 1000 },
  );
  const total = r.duration ?? (durationFrom(res.stderr) !== null ? durationFrom(res.stderr)! - (r.start ?? 0) : null);
  const offset = r.start ?? 0;
  const silences = parseSilence(res.stderr, total).map((s) => ({ start: +(s.start + offset).toFixed(3), end: +(s.end + offset).toFixed(3), duration: s.duration }));
  return { silences, total: total };
}

/** Invert silences into the parts worth keeping, padded so cuts don't clip breaths/word edges. */
export function keepSegments(silences: Silence[], total: number, padding: number, offset = 0): { start: number; end: number }[] {
  const keeps: { start: number; end: number }[] = [];
  let cursor = offset;
  for (const s of silences) {
    const end = Math.min(s.start + padding, s.end);
    if (end > cursor + 0.05) keeps.push({ start: +cursor.toFixed(3), end: +end.toFixed(3) });
    cursor = Math.max(cursor, s.end - padding);
  }
  const finalEnd = offset + total;
  if (finalEnd > cursor + 0.05) keeps.push({ start: +cursor.toFixed(3), end: +finalEnd.toFixed(3) });
  return keeps;
}

export function ts(seconds: number): string {
  return formatTimestamp(seconds);
}

/* ---------------------------------------------------------------- normalize */

export interface LoudnormPass1 {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
  normalization_type?: string;
  output_i?: string;
  output_tp?: string;
}

export function parseLoudnormJson(stderr: string): LoudnormPass1 {
  const idx = stderr.lastIndexOf("Parsed_loudnorm");
  const block = stderr.slice(idx);
  const m = block.match(/\{[\s\S]*?\}/);
  if (!m) throw new Error("Could not read loudnorm measurement from ffmpeg output.");
  return JSON.parse(m[0]) as LoudnormPass1;
}

export function audioCodecFor(output: string): { args: string[]; keepsVideo: boolean } {
  const ext = path.extname(output).toLowerCase();
  switch (ext) {
    case ".wav":
      return { args: ["-c:a", "pcm_s24le"], keepsVideo: false };
    case ".aif":
    case ".aiff":
      return { args: ["-c:a", "pcm_s24be"], keepsVideo: false };
    case ".flac":
      return { args: ["-c:a", "flac"], keepsVideo: false };
    case ".mp3":
      return { args: ["-c:a", "libmp3lame", "-b:a", "320k"], keepsVideo: false };
    case ".m4a":
    case ".aac":
      return { args: ["-c:a", "aac", "-b:a", "256k"], keepsVideo: false };
    case ".mp4":
    case ".mov":
    case ".m4v":
    case ".mkv":
      return { args: ["-c:a", "aac", "-b:a", "256k"], keepsVideo: true };
    case ".opus":
    case ".ogg":
      return { args: ["-c:a", "libopus", "-b:a", "160k"], keepsVideo: false };
    default:
      throw new Error(`Unsupported output extension "${ext}". Use .wav, .flac, .mp3, .m4a, .mp4, .mov, .mkv, .aiff or .opus.`);
  }
}
