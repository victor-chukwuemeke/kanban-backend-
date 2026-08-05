/**
 * Query plan capture — the "before" and "after" evidence for question 2.5.
 *
 * Runs the real queries behind the Board module through explain("executionStats")
 * and prints the numbers that matter. Run it once before adding any index, save
 * the output, then run it again after. The two outputs are the answer.
 *
 *   node scripts/explain.js --email you@example.com
 *   node scripts/explain.js --email you@example.com --json > before.json
 *
 * The number to watch is totalDocsExamined vs nReturned. Examining 5000
 * documents to return 12 is the whole finding in one ratio.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../src/models/User");
const Board = require("../src/models/Board");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const EMAIL = arg("email");
const AS_JSON = process.argv.includes("--json");

function unwrap(plan) {
  // Descend past SINGLE_SHARD / SHARDING_FILTER wrappers Atlas may add.
  let stage = plan.executionStats.executionStages;
  while (stage.inputStage || stage.inputStages) {
    if (stage.inputStages) return { top: plan.executionStats.executionStages.stage, stage };
    stage = stage.inputStage;
  }
  return { top: plan.executionStats.executionStages.stage, stage };
}

function describe(label, query, plan) {
  const es = plan.executionStats;
  const { stage } = unwrap(plan);

  const stages = [];
  (function walk(s) {
    if (!s) return;
    stages.push(s.stage);
    if (s.inputStage) walk(s.inputStage);
    if (s.inputStages) s.inputStages.forEach(walk);
  })(es.executionStages);

  const scanKind = stages.includes("COLLSCAN")
    ? "COLLSCAN  ← full collection scan"
    : stages.includes("IXSCAN")
    ? "IXSCAN    ← index scan"
    : stages.join(" → ");

  // An $or that uses two indexes has two IXSCAN branches, so collect every
  // index named anywhere in the tree rather than just the first one.
  const used = [];
  (function names(s) {
    if (!s) return;
    if (s.indexName && !used.includes(s.indexName)) used.push(s.indexName);
    if (s.inputStage) names(s.inputStage);
    if (s.inputStages) s.inputStages.forEach(names);
  })(es.executionStages);

  const examined = es.totalDocsExamined;
  const returned = es.nReturned;
  const waste = returned > 0 ? (examined / returned).toFixed(1) : "n/a";

  console.log(`\n${"─".repeat(64)}`);
  console.log(label);
  console.log(`${"─".repeat(64)}`);
  console.log(`  query              ${JSON.stringify(query)}`);
  console.log(`  plan               ${scanKind}`);
  console.log(`  stages             ${stages.join(" → ")}`);
  console.log(`  index used         ${used.length ? used.join(" + ") : "none"}`);
  console.log(`  docs examined      ${examined}`);
  console.log(`  keys examined      ${es.totalKeysExamined}`);
  console.log(`  docs returned      ${returned}`);
  console.log(`  examined:returned  ${waste}:1`);
  console.log(`  execution time     ${es.executionTimeMillis} ms`);
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set. Copy server/.env to the repo root.");
    process.exit(1);
  }
  if (!EMAIL) {
    console.error("Pass --email <the account you log in as>");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const user = await User.findOne({ email: EMAIL.toLowerCase() });
  if (!user) {
    console.error(`No user with email ${EMAIL}.`);
    process.exit(1);
  }

  const total = await Board.countDocuments();
  const indexes = await Board.collection.indexes();

  console.log(`\nDatabase          ${mongoose.connection.name}`);
  console.log(`Boards            ${total}`);
  console.log(`Indexes on boards ${indexes.map((i) => i.name).join(", ")}`);

  if (total < 1000) {
    console.log(
      `\n⚠  Only ${total} boards. A scan over this many documents is instant and\n` +
        `   proves nothing. Run scripts/seed.js first.`
    );
  }

  // 1. The board list — the real hot read, and the one with no index.
  const listQuery = { $or: [{ userId: user._id }, { "members.userId": user._id }] };
  const listPlan = await Board.find(listQuery).explain("executionStats");
  describe("GET /api/boards  —  board list", listQuery, listPlan);

  // 2. Single board by _id — used by requireRole on EVERY write. Already indexed;
  //    included as the contrast case.
  const anyBoard = await Board.findOne(listQuery).select("_id");
  if (anyBoard) {
    const byIdQuery = { _id: anyBoard._id };
    const byIdPlan = await Board.find(byIdQuery).explain("executionStats");
    describe("requireRole  —  Board.findById", byIdQuery, byIdPlan);
  }

  // 3. Avatar sync fan-out — same unindexed field, on every avatar change.
  const syncQuery = { "members.userId": user._id };
  const syncPlan = await Board.find(syncQuery).explain("executionStats");
  describe("syncAvatarAcrossBoards  —  updateMany filter", syncQuery, syncPlan);

  if (AS_JSON) {
    console.error("\n(raw plans on stdout)");
    process.stdout.write(JSON.stringify({ listPlan, syncPlan }, null, 2));
  }

  console.log(
    `\n${"─".repeat(64)}\nSave this output before changing anything.\n`
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("\nExplain failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
