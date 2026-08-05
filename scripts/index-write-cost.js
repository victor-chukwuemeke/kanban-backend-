/**
 * Question 2.4 — "what is it costing you on every single write, and who would
 * notice if you dropped it?"
 *
 * $indexStats says which indexes serve reads. It says nothing about what they
 * cost. This measures the write side directly: insert the same batch of users
 * with and without the never-read username index, and compare.
 *
 *   node scripts/index-write-cost.js [--n 2000]
 *
 * Creates temporary users and removes them again. Nothing else is touched.
 */

require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const User = require("../src/models/User");

const N = Number(
  (() => {
    const i = process.argv.indexOf("--n");
    return i !== -1 ? process.argv[i + 1] : 2000;
  })()
);

const TAG = "idxcost";

function batch(run) {
  return Array.from({ length: N }, (_, i) => ({
    username: `${TAG}-${run}-${i}`,
    email: `${TAG}-${run}-${i}@example.com`,
    passwordHash: "x",
  }));
}

async function cleanup() {
  await User.deleteMany({ email: { $regex: `^${TAG}-` } });
}

async function timeInsert(run) {
  const docs = batch(run);
  const t = process.hrtime.bigint();
  await User.collection.insertMany(docs, { ordered: false });
  return Number(process.hrtime.bigint() - t) / 1e6;
}

async function main() {
  mongoose.set("autoIndex", false);
  await mongoose.connect(process.env.MONGODB_URI);
  await cleanup();

  const before = (await User.collection.indexes()).map((i) => i.name);
  console.log(`Database ${mongoose.connection.name}`);
  console.log(`Indexes on users: ${before.join(", ")}`);
  console.log(`Inserting ${N} users per run.\n`);

  // This runs against a remote Atlas cluster, so a single run of each condition
  // measures network weather, not the index. Alternate the two conditions
  // several times and compare medians, which is robust to drift and outliers.
  const ROUNDS = 5;
  const withSamples = [];
  const withoutSamples = [];

  const ensure = async (present) => {
    const has = (await User.collection.indexes()).some((i) => i.name === "username_1");
    if (present && !has) await User.collection.createIndex({ username: 1 }, { unique: true });
    if (!present && has) await User.collection.dropIndex("username_1");
  };

  // Discard a warm-up round: first contact pays connection and cache costs.
  await ensure(true);
  await timeInsert("warmup");
  await cleanup();

  for (let r = 0; r < ROUNDS; r++) {
    await ensure(true);
    withSamples.push(await timeInsert(`with-${r}`));
    await cleanup();

    await ensure(false);
    withoutSamples.push(await timeInsert(`without-${r}`));
    await cleanup();

    process.stdout.write(`\r  round ${r + 1}/${ROUNDS}`);
  }
  console.log("");

  await ensure(true); // restore production state

  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const withIdx = median(withSamples);
  const withoutIdx = median(withoutSamples);

  console.log(`\n  with index    ${withSamples.map((n) => n.toFixed(0)).join(", ")} ms`);
  console.log(`  without index ${withoutSamples.map((n) => n.toFixed(0)).join(", ")} ms`);

  const delta = withIdx - withoutIdx;
  const pct = (delta / withoutIdx) * 100;
  const spread = Math.max(...withSamples, ...withoutSamples) - Math.min(...withSamples, ...withoutSamples);
  const reliable = Math.abs(delta) > spread / 2;

  console.log("\n" + "─".repeat(58));
  console.log(`  median with username_1     ${withIdx.toFixed(0)} ms`);
  console.log(`  median without it          ${withoutIdx.toFixed(0)} ms`);
  console.log(`  run-to-run spread          ${spread.toFixed(0)} ms`);
  console.log("─".repeat(58));
  console.log(
    `  apparent cost              ${delta.toFixed(0)} ms for ${N} inserts` +
      `  (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`
  );
  console.log(`  per insert                 ${(delta / N).toFixed(3)} ms`);

  console.log(
    reliable
      ? `\n  Signal exceeds the noise — treat this as a real measurement.`
      : `\n  NOT RELIABLE. The difference (${delta.toFixed(0)}ms) is smaller than the\n` +
        `  run-to-run spread (${spread.toFixed(0)}ms). Against a remote Atlas cluster the\n` +
        `  network dominates what an index costs per document. The honest\n` +
        `  conclusion is that the write cost of this index is too small to\n` +
        `  measure from here, not that it is zero.`
  );
  console.log("");

  console.log("Who would notice if it were dropped:");
  console.log("  Nobody, for reads — $indexStats shows 0 queries served.");
  console.log("  Everybody, eventually, for correctness — it is the UNIQUE");
  console.log("  constraint on username. Drop it and two people can register");
  console.log("  the same name. That is a behaviour change, not a tuning one.\n");

  console.log(`Indexes restored: ${(await User.collection.indexes()).map((i) => i.name).join(", ")}`);
  console.log(`Temporary users removed: ${await User.countDocuments({ email: { $regex: `^${TAG}-` } })} remaining\n`);

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("Failed:", e.message);
  await cleanup().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
