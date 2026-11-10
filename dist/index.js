#!/usr/bin/env node
/**
 * loudness-check-mcp — measure, check and fix audio loudness from any MCP client.
 */
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { expandPath, installHelp, parseTimestamp, prepareOutput, requireFile, resolveBinary, run, runOrThrow, SetupError, toCommand, versionOf, } from "./lib/ffmpeg.js";
import { audioCodecFor, checkAcx, checkTarget, detectSilence, keepSegments, measure, parseLoudnormJson, peakRanges, TARGETS, ts, windows, } from "./lib/loudness.js";
import { guard, markdownTable, ok } from "./lib/tool.js";
const VERSION = "1.0.0";
const targetIds = Object.keys(TARGETS);
const server = new McpServer({ name: "loudness-check-mcp", version: VERSION }, {
    instructions: "Audio loudness tools for local audio and video files. measure_loudness gives the EBU R128 numbers (integrated LUFS, true peak, LRA); " +
        "check_loudness_targets compares them to YouTube, Spotify, Apple, podcast, social and broadcast targets (plus ACX audiobook rules); " +
        "normalize_loudness writes a corrected copy (exact gain when possible, two-pass loudnorm otherwise); loudness_timeline, detect_silence and detect_clipping find where problems are.",
});
const fileArg = z.string().describe("Absolute path to a local audio or video file. ~ is expanded.");
const rangeArgs = {
    start: z.union([z.number(), z.string()]).optional().describe("Only analyse from this time (seconds or HH:MM:SS)."),
    duration: z.number().positive().optional().describe("Only analyse this many seconds."),
    audio_stream: z.number().int().min(0).default(0).describe("Which audio stream to use if the file has several (0 = first)."),
};
function range(a) {
    return { start: a.start === undefined ? undefined : parseTimestamp(a.start), duration: a.duration };
}
const f1 = (v, unit = "") => (v === null || v === undefined ? "—" : !Number.isFinite(v) ? `${v > 0 ? "+" : "-"}inf${unit}` : `${v.toFixed(1)}${unit}`);
function measurementText(name, m) {
    return [
        `**${name}**${m.duration_seconds ? ` (${m.duration_seconds.toFixed(1)}s analysed)` : ""}`,
        `- Integrated loudness: **${f1(m.integrated_lufs, " LUFS")}**`,
        `- True peak: **${f1(m.true_peak_dbtp, " dBTP")}**  ·  sample peak ${f1(m.sample_peak_dbfs, " dBFS")}`,
        `- Loudness range (LRA): ${f1(m.loudness_range_lu, " LU")}${m.loudness_range_lu !== null && (m.duration_seconds ?? 0) >= 30 ? (m.loudness_range_lu > 15 ? " — very dynamic; quiet parts may get lost on phones" : m.loudness_range_lu < 4 ? " — heavily compressed" : "") : ""}`,
        `- Max momentary / short-term: ${f1(m.max_momentary_lufs, " LUFS")} / ${f1(m.max_short_term_lufs, " LUFS")}`,
        `- RMS: ${f1(m.rms_dbfs, " dBFS")}  ·  noise floor: ${f1(m.noise_floor_dbfs, " dBFS")}${m.dc_offset !== null && Math.abs(m.dc_offset) > 0.01 ? `  ·  ⚠️ DC offset ${m.dc_offset.toFixed(3)}` : ""}`,
    ].join("\n");
}
function measurementData(m) {
    const { frames, ...rest } = m;
    return { ...rest, frames_analysed: frames.length };
}
const ICON = { pass: "✅", warn: "⚠️", fail: "❌" };
/* ---------------------------------------------------------------- tools */
server.registerTool("check_setup", {
    title: "Check ffmpeg setup",
    description: "Confirm ffmpeg is installed (with the ebur128 and loudnorm filters) and report its version and path. Run this first if other tools fail.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
}, async () => guard(async () => {
    try {
        const bin = await resolveBinary("ffmpeg");
        const v = await versionOf("ffmpeg");
        const filters = await run("ffmpeg", ["-hide_banner", "-filters"], { timeoutMs: 15000 });
        const need = ["ebur128", "loudnorm", "astats", "silencedetect"];
        const missing = need.filter((f) => !new RegExp(`\\s${f}\\s`).test(filters.stdout));
        return ok(`ffmpeg: ${bin}\n  ${v}\n${missing.length ? `Missing filters: ${missing.join(", ")} — install a full ffmpeg build.` : "All required filters present. Ready."}`, { ffmpeg: bin, version: v, missing_filters: missing });
    }
    catch (e) {
        if (e instanceof SetupError)
            return ok(e.message, { ready: false });
        throw e;
    }
}));
server.registerTool("measure_loudness", {
    title: "Measure loudness (EBU R128)",
    description: "Measure a file's loudness the way streaming platforms and broadcasters do: integrated loudness (LUFS), true peak (dBTP), loudness range (LRA), " +
        "max momentary and short-term loudness, plus sample peak, RMS, noise floor and DC offset. Works on audio files and on the audio track of videos. " +
        "Optionally compare to targets in the same call.",
    inputSchema: {
        path: fileArg,
        ...rangeArgs,
        targets: z.array(z.enum(targetIds)).optional().describe(`Also compare to these targets: ${targetIds.join(", ")}`),
    },
    annotations: { readOnlyHint: true },
}, async (a) => guard(async () => {
    const file = await requireFile(a.path);
    const m = await measure(file, range(a), a.audio_stream);
    let text = measurementText(path.basename(file), m);
    const checks = (a.targets ?? []).map((t) => checkTarget(m, TARGETS[t]));
    if (checks.length)
        text += `\n\n${markdownTable(["", "target", "goal", "delta", "what happens"], checks.map((c) => [ICON[c.verdict], c.name, `${c.target_lufs} LUFS / ${c.max_true_peak} dBTP`, c.delta_lu === null ? "—" : `${c.delta_lu > 0 ? "+" : ""}${c.delta_lu} LU`, c.what_happens]))}`;
    return ok(text, { file, ...measurementData(m), targets: checks });
}));
server.registerTool("check_loudness_targets", {
    title: "Check against platform loudness targets",
    description: "Compare a file to loudness targets and explain what each platform will do with it (turn it down, leave it quieter, or reject it for broadcast). " +
        "Targets: YouTube, Spotify, Apple Music, Tidal, social (Instagram/TikTok/Shorts), podcast, EBU R128, ATSC A/85. Optionally checks ACX audiobook rules (RMS, peak, noise floor).",
    inputSchema: {
        path: fileArg,
        ...rangeArgs,
        targets: z.array(z.enum(targetIds)).default(["youtube", "spotify", "social", "podcast"]).describe(`Targets: ${targetIds.join(", ")}`),
        include_acx: z.boolean().default(false).describe("Also check ACX/Audible audiobook requirements."),
    },
    annotations: { readOnlyHint: true },
}, async (a) => guard(async () => {
    const file = await requireFile(a.path);
    const m = await measure(file, range(a), a.audio_stream);
    const checks = a.targets.map((t) => checkTarget(m, TARGETS[t]));
    let text = `${measurementText(path.basename(file), m)}\n\n${markdownTable(["", "target", "goal", "measured", "delta", "what happens"], checks.map((c) => [ICON[c.verdict], c.name, `${c.target_lufs} LUFS, ≤ ${c.max_true_peak} dBTP`, `${f1(c.integrated_lufs)} LUFS, ${f1(c.true_peak_dbtp)} dBTP`, c.delta_lu === null ? "—" : `${c.delta_lu > 0 ? "+" : ""}${c.delta_lu} LU`, c.what_happens]))}`;
    let acx;
    if (a.include_acx) {
        acx = checkAcx(m);
        text += `\n\n**ACX audiobook: ${ICON[acx.verdict]} ${acx.verdict.toUpperCase()}**\n${markdownTable(["", "check", "measured", "required"], acx.rows.map((r) => [r.pass ? "✅" : "❌", r.check, f1(r.actual, " dB"), r.expected]))}\n_${acx.note}_`;
    }
    const notes = checks.map((c) => `- ${c.name}: ${TARGETS[c.target].behaviour}`).join("\n");
    text += `\n\n${notes}`;
    const failing = checks.filter((c) => c.fix);
    if (failing.length)
        text += `\n\nFix: ${failing[0].fix}`;
    return ok(text, { file, measurement: measurementData(m), checks, acx });
}));
server.registerTool("normalize_loudness", {
    title: "Normalize loudness",
    description: "Write a loudness-corrected copy. The file is measured first; if a plain gain change reaches the target without exceeding the true-peak ceiling, " +
        "exactly that gain is applied (linear, dynamics untouched). Otherwise ffmpeg's two-pass dynamic loudnorm is used to hit both targets. " +
        "Pick a target preset or give custom integrated LUFS / true-peak / LRA values. " +
        "For video files the video stream is copied untouched. The result is re-measured. Never overwrites without overwrite: true.",
    inputSchema: {
        path: fileArg,
        output_path: z.string().optional().describe("Output file; the extension picks the codec (.wav 24-bit, .flac, .mp3 320k, .m4a/.mp4/.mov AAC 256k, .opus). Defaults to <name>_<target>.<ext> next to the source."),
        target: z.enum(targetIds).optional().describe("Preset target. Ignored when integrated_lufs is given."),
        integrated_lufs: z.number().min(-40).max(-5).optional().describe("Custom integrated loudness target."),
        true_peak_dbtp: z.number().min(-9).max(0).optional().describe("Custom true-peak ceiling."),
        lra_lu: z.number().min(1).max(50).default(11).describe("Target loudness range used in dynamic mode."),
        linear: z.boolean().default(true).describe("Prefer an exact gain change (keeps your mix's dynamics). If that would push true peak over the ceiling, dynamic loudnorm is used instead and the result explains why."),
        sample_rate: z.number().int().optional().describe("Output sample rate. Defaults to the source rate (or 48000)."),
        audio_stream: z.number().int().min(0).default(0),
        dry_run: z.boolean().default(false).describe("Measure and return the pass-2 command without writing."),
        overwrite: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
}, async (a) => guard(async () => {
    const file = await requireFile(a.path);
    const preset = a.target ? TARGETS[a.target] : TARGETS.youtube;
    const I = a.integrated_lufs ?? preset.integrated;
    const TP = a.true_peak_dbtp ?? preset.max_true_peak;
    const label = a.integrated_lufs !== undefined ? `${I}lufs` : preset.id;
    const srcExt = path.extname(file).toLowerCase() || ".wav";
    const defaultExt = [".mp4", ".mov", ".m4v", ".mkv", ".wav", ".flac", ".mp3", ".m4a", ".aiff", ".aif", ".opus"].includes(srcExt) ? srcExt : ".wav";
    const out = expandPath(a.output_path ?? path.join(path.dirname(file), `${path.parse(file).name}_${label}${defaultExt}`));
    const codec = audioCodecFor(out);
    // Pass 1
    const p1 = await runOrThrow("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-map", `0:a:${a.audio_stream}`, "-af", `loudnorm=I=${I}:TP=${TP}:LRA=${a.lra_lu}:print_format=json`, "-f", "null", "-"], { timeoutMs: 30 * 60 * 1000 });
    const m1 = parseLoudnormJson(p1.stderr);
    const inI = Number(m1.input_i);
    const inTP = Number(m1.input_tp);
    if (!Number.isFinite(inI) || inI < -69)
        throw new Error("The audio is silent (or nearly), so there is no loudness to normalize.");
    const srcRate = Number(p1.stderr.match(/Audio:[^\n]*?(\d{4,6}) Hz/)?.[1]) || 48000;
    const rate = a.sample_rate ?? srcRate;
    // Linear: an exact gain change, when it keeps true peak under the ceiling.
    const gain = I - inI;
    const predictedTP = inTP + gain;
    const linearFits = a.linear && predictedTP <= TP + 0.05;
    let filter;
    let mode;
    let modeNote = "";
    if (linearFits) {
        filter = `volume=${gain.toFixed(2)}dB`;
        mode = `linear (${gain >= 0 ? "+" : ""}${gain.toFixed(2)} dB gain)`;
    }
    else {
        filter =
            `loudnorm=I=${I}:TP=${TP}:LRA=${a.lra_lu}:measured_I=${m1.input_i}:measured_TP=${m1.input_tp}:measured_LRA=${m1.input_lra}:` +
                `measured_thresh=${m1.input_thresh}:offset=${m1.target_offset}:linear=false:print_format=summary`;
        mode = "dynamic (loudnorm)";
        if (a.linear) {
            modeNote =
                `\n⚠️ A clean gain of ${gain >= 0 ? "+" : ""}${gain.toFixed(1)} dB would put the true peak at ${predictedTP.toFixed(1)} dBTP, above the ${TP} dBTP ceiling, ` +
                    "so loudnorm's dynamic mode was used (it gently compresses and limits to hit both targets). To stay fully linear: lower the target, raise true_peak_dbtp, or put a limiter on the mix first.";
        }
    }
    const args = ["-hide_banner", "-nostats", "-y", "-i", file];
    if (codec.keepsVideo)
        args.push("-map", "0:v?", "-c:v", "copy");
    else
        args.push("-vn");
    args.push("-map", `0:a:${a.audio_stream}`, "-af", filter, "-ar", String(rate), ...codec.args);
    if (codec.keepsVideo)
        args.push("-movflags", "+faststart");
    args.push(out);
    const cmd = toCommand("ffmpeg", args);
    const before = `Source: ${m1.input_i} LUFS, ${m1.input_tp} dBTP, LRA ${m1.input_lra} LU → target ${I} LUFS, ${TP} dBTP.`;
    if (a.dry_run)
        return ok(`${before}\nMode: ${mode}.${modeNote}\n\nCommand:\n\`\`\`sh\n${cmd}\n\`\`\``, { pass1: m1, mode, command: cmd });
    await prepareOutput(out, a.overwrite, file);
    await runOrThrow("ffmpeg", args, { timeoutMs: 60 * 60 * 1000 });
    const after = await measure(out);
    const size = (await stat(out)).size;
    const lossy = /\.(mp3|m4a|aac|mp4|mov|m4v|mkv|opus|ogg)$/i.test(out);
    const encNote = lossy && after.true_peak_dbtp !== null && after.true_peak_dbtp > TP + 0.3 ? `\nℹ️ Lossy encoding raised the true peak to ${after.true_peak_dbtp.toFixed(1)} dBTP. Use a ceiling ~0.5 dB lower if you need strict compliance.` : "";
    return ok(`${before}\nMode: ${mode}.${modeNote}\n\nSaved ${out} (${(size / 1024 / 1024).toFixed(1)} MB).\n\nAfter:\n${measurementText(path.basename(out), after)}${encNote}`, { output: out, mode, gain_db: linearFits ? +gain.toFixed(2) : null, before: m1, after: measurementData(after) });
}));
server.registerTool("loudness_timeline", {
    title: "Loudness over time",
    description: "Break a file into windows (default 5 s) and report max momentary loudness, short-term loudness and true peak for each, then point out the loudest and " +
        "quietest sections and sudden jumps. Use it to find the ad-read that's too hot, the guest who's too quiet, or the music sting that spikes. Optional CSV export.",
    inputSchema: {
        path: fileArg,
        ...rangeArgs,
        window_seconds: z.number().min(0.5).max(600).default(5),
        jump_lu: z.number().min(1).max(30).default(6).describe("Flag windows whose max momentary loudness jumps by at least this much from the previous window (silence is ignored)."),
        max_rows: z.number().int().min(5).max(2000).default(120),
        csv_output_path: z.string().optional(),
        overwrite: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false },
}, async (a) => guard(async () => {
    const file = await requireFile(a.path);
    const r = range(a);
    const m = await measure(file, r, a.audio_stream);
    const ws = windows(m.frames, a.window_seconds, r.start ?? 0);
    const voiced = ws.filter((w) => w.max_short_term !== null);
    const loudest = [...voiced].sort((x, y) => y.max_short_term - x.max_short_term).slice(0, 3);
    const quietest = [...voiced].sort((x, y) => x.max_short_term - y.max_short_term).slice(0, 3);
    const jumps = ws.filter((w, i) => i > 0 && w.max_momentary !== null && ws[i - 1].max_momentary !== null && Math.abs(w.max_momentary - ws[i - 1].max_momentary) >= a.jump_lu);
    const rows = ws.slice(0, a.max_rows).map((w) => [`${ts(w.start).slice(0, 10)}–${ts(w.end).slice(0, 10)}`, f1(w.max_momentary), f1(w.max_short_term), f1(w.max_true_peak)]);
    let csvNote = "";
    if (a.csv_output_path) {
        const out = await prepareOutput(a.csv_output_path, a.overwrite);
        await writeFile(out, ["start_s,end_s,max_momentary_lufs,max_short_term_lufs,max_true_peak_dbtp", ...ws.map((w) => [w.start, w.end, w.max_momentary ?? "", w.max_short_term ?? "", w.max_true_peak ?? ""].join(","))].join("\n") + "\n");
        csvNote = `\nCSV saved to ${out}`;
    }
    const fmtW = (w) => `${ts(w.start).slice(0, 8)} (${f1(w.max_short_term)} LUFS)`;
    const text = `${path.basename(file)} — integrated ${f1(m.integrated_lufs, " LUFS")}, ${ws.length} windows of ${a.window_seconds}s.\n` +
        `Loudest: ${loudest.map(fmtW).join(", ") || "—"}\nQuietest: ${quietest.map(fmtW).join(", ") || "—"}\n` +
        `Jumps ≥ ${a.jump_lu} LU: ${jumps.length ? jumps.slice(0, 10).map((w) => ts(w.start).slice(0, 8)).join(", ") : "none"}\n\n` +
        markdownTable(["window", "max momentary", "max short-term", "max true peak"], rows) +
        (ws.length > rows.length ? `\n(${ws.length - rows.length} more windows; use csv_output_path for all)` : "") +
        csvNote;
    return ok(text, { integrated_lufs: m.integrated_lufs, loudest, quietest, jumps, windows: ws.length });
}));
server.registerTool("detect_silence", {
    title: "Detect silence / dead air",
    description: "Find silent stretches (below a noise threshold for at least a minimum duration). Returns each gap with timestamps and totals, and optionally the " +
        "inverse — padded 'keep' segments — so you can plan jump cuts or tighten a podcast. Can export the keep list as CSV or an ffmpeg concat-ready list.",
    inputSchema: {
        path: fileArg,
        ...rangeArgs,
        noise_db: z.number().min(-90).max(-10).default(-45).describe("Anything quieter than this counts as silence. Raise (e.g. -35) for noisy rooms."),
        min_silence_seconds: z.number().min(0.05).max(60).default(0.6),
        keep_padding_seconds: z.number().min(0).max(2).default(0.12).describe("Breathing room left around speech when building keep segments."),
        include_keep_segments: z.boolean().default(true),
        max_rows: z.number().int().min(1).max(5000).default(100),
        csv_output_path: z.string().optional().describe("Write silences and keep segments to CSV."),
        overwrite: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false },
}, async (a) => guard(async () => {
    const file = await requireFile(a.path);
    const r = range(a);
    const { silences, total } = await detectSilence(file, a.noise_db, a.min_silence_seconds, r, a.audio_stream);
    const silentTotal = silences.reduce((s, x) => s + x.duration, 0);
    const keeps = a.include_keep_segments && total !== null ? keepSegments(silences, total, a.keep_padding_seconds, r.start ?? 0) : [];
    const keptTotal = keeps.reduce((s, k) => s + (k.end - k.start), 0);
    let csvNote = "";
    if (a.csv_output_path) {
        const out = await prepareOutput(a.csv_output_path, a.overwrite);
        const lines = ["type,start_s,end_s,duration_s", ...silences.map((s) => `silence,${s.start},${s.end},${s.duration}`), ...keeps.map((k) => `keep,${k.start},${k.end},${(k.end - k.start).toFixed(3)}`)];
        await writeFile(out, lines.join("\n") + "\n");
        csvNote = `\nCSV saved to ${out}`;
    }
    const head = `${silences.length} silent stretch(es) ≥ ${a.min_silence_seconds}s below ${a.noise_db} dB — ${silentTotal.toFixed(1)}s total${total ? ` of ${total.toFixed(1)}s (${((silentTotal / total) * 100).toFixed(0)}%)` : ""}.`;
    const table = silences.length ? `\n\n${markdownTable(["#", "start", "end", "length"], silences.slice(0, a.max_rows).map((s, i) => [i + 1, ts(s.start), ts(s.end), `${s.duration.toFixed(2)}s`]))}` : "";
    const keepText = keeps.length ? `\n\nKeeping ${keeps.length} segment(s) with ${a.keep_padding_seconds}s padding → ${keptTotal.toFixed(1)}s (saves ${total ? (total - keptTotal).toFixed(1) : "?"}s).` : "";
    return ok(head + table + (silences.length > a.max_rows ? `\n(${silences.length - a.max_rows} more)` : "") + keepText + csvNote, { total_seconds: total, silent_seconds: +silentTotal.toFixed(3), silences: silences.slice(0, a.max_rows), keep_segments: keeps.slice(0, a.max_rows) });
}));
server.registerTool("detect_clipping", {
    title: "Detect clipping and hot peaks",
    description: "Check for digital clipping and peaks that will distort after MP3/AAC encoding: sample peak, true peak, flat factor (runs of samples stuck at full scale), " +
        "and the time ranges where the true peak crosses a threshold.",
    inputSchema: {
        path: fileArg,
        ...rangeArgs,
        threshold_dbtp: z.number().min(-12).max(3).default(-1).describe("Report ranges where the frame true peak reaches this level."),
        max_rows: z.number().int().min(1).max(1000).default(50),
    },
    annotations: { readOnlyHint: true },
}, async (a) => guard(async () => {
    const file = await requireFile(a.path);
    const r = range(a);
    const m = await measure(file, r, a.audio_stream);
    const ranges = peakRanges(m.frames, a.threshold_dbtp, r.start ?? 0);
    const clipped = (m.sample_peak_dbfs ?? -99) >= -0.1 && (m.flat_factor ?? 0) > 0;
    const overZero = (m.true_peak_dbtp ?? -99) > 0;
    const verdict = clipped ? "fail" : overZero || ranges.length ? "warn" : "pass";
    const lines = [
        `${ICON[verdict]} ${clipped ? "Clipping detected: samples are flat-topped at full scale." : overZero ? "No flat clipping, but true peak is above 0 dBTP — inter-sample overs will distort after lossy encoding." : ranges.length ? `Peaks reach ${a.threshold_dbtp} dBTP in ${ranges.length} place(s).` : "No clipping and no peaks above the threshold."}`,
        `Sample peak ${f1(m.sample_peak_dbfs, " dBFS")} · true peak ${f1(m.true_peak_dbtp, " dBTP")} · flat factor ${f1(m.flat_factor)}`,
    ];
    if (ranges.length)
        lines.push("", markdownTable(["#", "start", "end", "peak"], ranges.slice(0, a.max_rows).map((x, i) => [i + 1, ts(x.start), ts(x.end), `${x.peak.toFixed(1)} dBTP`])));
    if (verdict !== "pass")
        lines.push("", clipped ? "Clipping can't be undone by lowering the volume; re-export from the session with lower gain, or use a de-clip tool. For peaks only: normalize_loudness with a lower true_peak_dbtp, or a limiter." : "Fix: normalize_loudness (it limits true peak to the target ceiling) or put a true-peak limiter at -1 dBTP on the master.");
    return ok(lines.join("\n"), { verdict, clipped, sample_peak_dbfs: m.sample_peak_dbfs, true_peak_dbtp: m.true_peak_dbtp, flat_factor: m.flat_factor, ranges: ranges.slice(0, a.max_rows) });
}));
server.registerTool("list_targets", {
    title: "List loudness targets",
    description: "Show every loudness target this server knows, with integrated LUFS, tolerance, true-peak ceiling and how the platform behaves.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
}, async () => guard(async () => ok(markdownTable(["id", "name", "integrated", "true peak", "behaviour"], Object.values(TARGETS).map((t) => [t.id, t.name, `${t.integrated} LUFS ±${t.tolerance}`, `≤ ${t.max_true_peak} dBTP`, t.behaviour])) +
    "\n\nPlus `include_acx` on check_loudness_targets for ACX audiobook rules (RMS -23 to -18 dB, peak ≤ -3 dB, noise floor ≤ -60 dB).", TARGETS)));
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    resolveBinary("ffmpeg").catch(() => console.error(`[loudness-check-mcp] ${installHelp()}`));
    console.error(`[loudness-check-mcp] v${VERSION} ready on stdio`);
}
main().catch((e) => {
    console.error("[loudness-check-mcp] fatal:", e);
    process.exit(1);
});
