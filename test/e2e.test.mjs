import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { connect, fixture, hasFfmpeg, jsonOf, textOf, TMP } from "./helpers.mjs";

const skip = !hasFfmpeg() && "ffmpeg not installed";
let client, quiet, gappy, video;

before(async () => {
  if (skip) return;
  // pink-ish noise at a known low level: ~ -30 LUFS
  quiet = fixture("quiet.wav", ["-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.05:sample_rate=48000:duration=6", "-ac", "2"]);
  // speech-like bursts separated by 2s of silence
  gappy = fixture("gappy.wav", [
    "-f", "lavfi", "-i", "sine=f=300:sample_rate=48000:duration=3",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-f", "lavfi", "-i", "sine=f=500:sample_rate=48000:duration=3",
    "-filter_complex", "[1]atrim=duration=2[s];[0][s][2]concat=n=3:v=0:a=1",
  ]);
  video = fixture("clip.mp4", [
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=5",
    "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.05:sample_rate=48000:duration=5",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
  ]);
  client = await connect();
});
after(async () => client?.close());

test("lists tools", { skip }, async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_loudness_targets", "check_setup", "detect_clipping", "detect_silence", "list_targets", "loudness_timeline", "measure_loudness", "normalize_loudness"]);
});

test("check_setup reports filters", { skip }, async () => {
  assert.match(textOf(await client.callTool({ name: "check_setup", arguments: {} })), /Ready\./);
});

test("measure_loudness returns R128 numbers", { skip }, async () => {
  const d = jsonOf(await client.callTool({ name: "measure_loudness", arguments: { path: quiet, targets: ["youtube"] } }));
  assert.ok(d.integrated_lufs < -20 && d.integrated_lufs > -45, `I=${d.integrated_lufs}`);
  assert.ok(d.true_peak_dbtp < 0);
  assert.equal(d.targets[0].verdict, "warn");
});

test("check_loudness_targets with ACX", { skip }, async () => {
  const res = await client.callTool({ name: "check_loudness_targets", arguments: { path: quiet, targets: ["podcast", "ebu_r128"], include_acx: true } });
  const d = jsonOf(res);
  assert.equal(d.checks.length, 2);
  assert.ok(d.acx);
  assert.match(textOf(res), /Fix: normalize_loudness/);
});

test("normalize_loudness hits the target and keeps video", { skip }, async () => {
  const out = path.join(TMP, "clip_norm.mp4");
  rmSync(out, { force: true });
  const res = await client.callTool({ name: "normalize_loudness", arguments: { path: video, target: "youtube", output_path: out } });
  assert.ok(!res.isError, textOf(res));
  const d = jsonOf(res);
  assert.ok(Math.abs(d.after.integrated_lufs - -14) <= 1.0, `after=${d.after.integrated_lufs}`);
  assert.ok(d.after.true_peak_dbtp <= -0.8, `tp=${d.after.true_peak_dbtp}`);
  const probe = jsonOf(await client.callTool({ name: "measure_loudness", arguments: { path: out } }));
  assert.ok(probe.integrated_lufs);
  const again = await client.callTool({ name: "normalize_loudness", arguments: { path: video, target: "youtube", output_path: out } });
  assert.equal(again.isError, true);
});

test("normalize dry run returns a command", { skip }, async () => {
  const d = jsonOf(await client.callTool({ name: "normalize_loudness", arguments: { path: quiet, integrated_lufs: -16, true_peak_dbtp: -1.5, dry_run: true } }));
  assert.match(d.command, /volume=[\d.]+dB|loudnorm=I=-16:TP=-1.5/);
});

test("normalize uses an exact linear gain when peaks allow", { skip }, async () => {
  const tone = fixture("tone.wav", ["-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:duration=2", "-af", "volume=0.1"]);
  const out = path.join(TMP, "tone_podcast.wav");
  rmSync(out, { force: true });
  const res = await client.callTool({ name: "normalize_loudness", arguments: { path: tone, target: "podcast", output_path: out } });
  assert.ok(!res.isError, textOf(res));
  const d = jsonOf(res);
  assert.match(d.mode, /^linear/);
  assert.ok(Math.abs(d.after.integrated_lufs - -16) <= 0.3, `after=${d.after.integrated_lufs}`);
});

test("normalize falls back to dynamic and explains when peaks would clip", { skip }, async () => {
  const peaky = fixture("peaky.wav", ["-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.02:sample_rate=48000:duration=4", "-f", "lavfi", "-i", "sine=f=1000:sample_rate=48000:duration=0.05", "-filter_complex", "[1]volume=0.9,adelay=2000|2000[s];[0][s]amix=inputs=2:normalize=0"]);
  const out = path.join(TMP, "peaky_yt.wav");
  rmSync(out, { force: true });
  const res = await client.callTool({ name: "normalize_loudness", arguments: { path: peaky, target: "youtube", output_path: out } });
  assert.ok(!res.isError, textOf(res));
  assert.match(jsonOf(res).mode, /dynamic/);
  assert.match(textOf(res), /above the -1 dBTP ceiling/);
});

test("detect_silence finds the gap and keep segments", { skip }, async () => {
  const d = jsonOf(await client.callTool({ name: "detect_silence", arguments: { path: gappy, min_silence_seconds: 0.5 } }));
  assert.equal(d.silences.length, 1);
  assert.ok(Math.abs(d.silences[0].start - 3) < 0.1 && Math.abs(d.silences[0].end - 5) < 0.1);
  assert.equal(d.keep_segments.length, 2);
});

test("timeline and clipping", { skip }, async () => {
  const jump = fixture("jump.wav", ["-f", "lavfi", "-i", "sine=f=400:sample_rate=48000:duration=6", "-af", "volume='if(lt(t,3),0.1,1)':eval=frame"]);
  const tl = jsonOf(await client.callTool({ name: "loudness_timeline", arguments: { path: jump, window_seconds: 1 } }));
  assert.ok(tl.windows >= 5);
  assert.ok(tl.jumps.length >= 1);
  const hot = fixture("hot.wav", ["-f", "lavfi", "-i", "sine=f=1000:sample_rate=48000:duration=2", "-af", "volume=20dB,alimiter=limit=1:level=false", "-c:a", "pcm_s16le"]);
  const c = jsonOf(await client.callTool({ name: "detect_clipping", arguments: { path: hot } }));
  assert.notEqual(c.verdict, "pass");
  const clean = jsonOf(await client.callTool({ name: "detect_clipping", arguments: { path: quiet } }));
  assert.equal(clean.verdict, "pass");
});
