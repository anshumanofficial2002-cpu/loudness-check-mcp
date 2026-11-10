import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEbur128, parseAstats, parseSilence, keepSegments, checkTarget, checkAcx, TARGETS, windows, peakRanges, parseLoudnormJson, audioCodecFor } from "../dist/lib/loudness.js";

const EBU = `[Parsed_ebur128_1 @ 0x1] t: 0.1  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU  FTPK: -28.5 -28.5 dBFS  TPK: -28.5 -28.5 dBFS
[Parsed_ebur128_1 @ 0x1] t: 0.2  TARGET:-23 LUFS    M: -14.2 S: -16.0     I: -15.0 LUFS       LRA:   2.0 LU  FTPK: -0.4 -0.9 dBFS  TPK: -0.4 -0.9 dBFS
[Parsed_ebur128_1 @ 0x1] t: 0.3  TARGET:-23 LUFS    M: -18.0 S: -15.5     I: -15.0 LUFS       LRA:   2.0 LU  FTPK: -6.0 -6.0 dBFS  TPK: -0.4 -0.9 dBFS
[Parsed_ebur128_1 @ 0x1] Summary:

  Integrated loudness:
    I:         -15.0 LUFS
    Threshold: -25.2 LUFS

  Loudness range:
    LRA:         2.0 LU
    Threshold: -35.0 LUFS
    LRA low:   -16.5 LUFS
    LRA high:  -14.5 LUFS

  True peak:
    Peak:       -0.4 dBFS`;

test("parses ebur128 summary and frames", () => {
  const r = parseEbur128(EBU);
  assert.equal(r.integrated_lufs, -15);
  assert.equal(r.integrated_threshold_lufs, -25.2);
  assert.equal(r.loudness_range_lu, 2);
  assert.equal(r.true_peak_dbtp, -0.4);
  assert.equal(r.max_momentary_lufs, -14.2);
  assert.equal(r.max_short_term_lufs, -15.5);
  assert.equal(r.frames.length, 3);
  assert.equal(r.frames[1].ftpk, -0.4);
});

test("parses astats overall block", () => {
  const s = parseAstats(`[Parsed_astats_2 @ 0x] Channel: 1\n[Parsed_astats_2 @ 0x] Peak level dB: -3\n[Parsed_astats_2 @ 0x] Overall\n[Parsed_astats_2 @ 0x] DC offset: 0.000010\n[Parsed_astats_2 @ 0x] Peak level dB: -1.5\n[Parsed_astats_2 @ 0x] RMS level dB: -20.2\n[Parsed_astats_2 @ 0x] Flat factor: 0.000000\n[Parsed_astats_2 @ 0x] Noise floor dB: -inf`);
  assert.equal(s.sample_peak_dbfs, -1.5);
  assert.equal(s.rms_dbfs, -20.2);
  assert.equal(s.noise_floor_dbfs, -Infinity);
});

test("silence parsing closes a trailing silence at end of file", () => {
  const s = parseSilence("silence_start: 1.5\nsilence_end: 3 | silence_duration: 1.5\nsilence_start: 9.2\n", 10);
  assert.deepEqual(s, [{ start: 1.5, end: 3, duration: 1.5 }, { start: 9.2, end: 10, duration: 0.8 }]);
});

test("keep segments invert silences with padding", () => {
  const keeps = keepSegments([{ start: 2, end: 4, duration: 2 }], 10, 0.1);
  assert.deepEqual(keeps, [{ start: 0, end: 2.1 }, { start: 3.9, end: 10 }]);
});

test("target checks explain platform behaviour", () => {
  const m = { integrated_lufs: -9.5, true_peak_dbtp: 0.3, rms_dbfs: -12, sample_peak_dbfs: -0.1, noise_floor_dbfs: -70 };
  const yt = checkTarget(m, TARGETS.youtube);
  assert.equal(yt.verdict, "warn");
  assert.equal(yt.delta_lu, 4.5);
  assert.match(yt.what_happens, /turn it down ~4.5 dB/);
  assert.match(yt.what_happens, /True peak/);
  assert.equal(checkTarget(m, TARGETS.ebu_r128).verdict, "fail");
  const ok = checkTarget({ integrated_lufs: -14.2, true_peak_dbtp: -1.5 }, TARGETS.spotify);
  assert.equal(ok.verdict, "pass");
  assert.equal(checkAcx(m).verdict, "fail");
  assert.equal(checkAcx({ rms_dbfs: -20, sample_peak_dbfs: -4, noise_floor_dbfs: -65 }).verdict, "pass");
});

test("windows and peak ranges", () => {
  const frames = parseEbur128(EBU).frames;
  const w = windows(frames, 0.2);
  assert.equal(w.length, 2);
  assert.equal(w[0].max_true_peak, -0.4);
  assert.equal(w[1].max_short_term, -15.5);
  const p = peakRanges(frames, -1);
  assert.equal(p.length, 1);
  assert.equal(p[0].peak, -0.4);
});

test("loudnorm json and output codecs", () => {
  const j = parseLoudnormJson('[Parsed_loudnorm_0 @ 0x] \n{\n"input_i" : "-20.84",\n"input_tp" : "-18.98",\n"input_lra" : "11.70",\n"input_thresh" : "-30.98",\n"target_offset" : "-3.27"\n}');
  assert.equal(j.input_i, "-20.84");
  assert.deepEqual(audioCodecFor("/x/a.wav").args, ["-c:a", "pcm_s24le"]);
  assert.equal(audioCodecFor("/x/a.mp4").keepsVideo, true);
  assert.throws(() => audioCodecFor("/x/a.xyz"));
});
