/**
 * Times the actual queries behind the Board module, so "the slowest query" is a
 * measurement rather than an assumption.
 *
 *   node scripts/timings.js --email you@example.com [--runs 30]
 *
 * Reports p50 and p99 rather than an average, because an average hides the tail
 * and the tail is what users complain about.
 */

require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const User = require("../src/models/User");
const Board = require("../src/models/Board");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const EMAIL = arg("email");
const RUNS = Number(arg("runs", 30));

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function time(label, fn, note) {
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    const t = process.hrtime.bigint();
    await fn(i);
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    note,
    min: samples[0],
    p50: pct(samples, 50),
    p99: pct(samples, 99),
    max: samples[samples.length - 1],
  };
}

async function main() {
  if (!EMAIL) {
    console.error("Pass --email <account>");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);

  const user = await User.findOne({ email: EMAIL.toLowerCase() });
  const board = await Board.findOne({ userId: user._id });
  const total = await Board.countDocuments();
  const idx = (await Board.collection.indexes()).map((i) => i.name);

  console.log(`Database   ${mongoose.connection.name}`);
  console.log(`Boards     ${total}`);
  console.log(`Indexes    ${idx.join(", ")}`);
  console.log(`Runs       ${RUNS} per query\n`);

  const results = [];

  results.push(
    await time(
      "Board.find  $or  (board list)",
      () => Board.find({ $or: [{ userId: user._id }, { "members.userId": user._id }] }),
      "GET /api/boards"
    )
  );

  results.push(
    await time(
      "Board.findById  (requireRole)",
      () => Board.findById(board._id),
      "runs before EVERY request"
    )
  );

  results.push(
    await time(
      "Board.updateMany  members.userId",
      () => Board.updateMany({ "members.userId": user._id }, { $set: { "members.$[].role": "owner" } }),
      "avatar / profile fan-out"
    )
  );

  // The write path: load, mutate, save — exactly what a card move does.
  results.push(
    await time(
      "load + mutate + save  (card move)",
      async () => {
        const doc = await Board.findById(board._id);
        const src = doc.columns.find((c) => c.tasks.length > 0);
        if (!src) return;
        const dst = doc.columns.find((c) => c.name !== src.name);
        const t = src.tasks[0];
        t.status = dst.name;
        src.tasks.pull(t._id);
        dst.tasks.push(t);
        await doc.save();
      },
      "PATCH .../status  end to end"
    )
  );

  const w = Math.max(...results.map((r) => r.label.length));
  console.log(
    `${"query".padEnd(w)}   ${"min".padStart(8)}${"p50".padStart(9)}${"p99".padStart(9)}${"max".padStart(9)}`
  );
  console.log("─".repeat(w + 38));
  for (const r of results.sort((a, b) => b.p50 - a.p50)) {
    console.log(
      `${r.label.padEnd(w)}   ${r.min.toFixed(1).padStart(7)}ms${r.p50.toFixed(1).padStart(8)}ms` +
        `${r.p99.toFixed(1).padStart(8)}ms${r.max.toFixed(1).padStart(8)}ms`
    );
  }
  console.log("");
  for (const r of results) console.log(`  ${r.label}  —  ${r.note}`);
  console.log("");

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("Failed:", e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
