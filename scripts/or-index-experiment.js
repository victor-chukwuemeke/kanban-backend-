/**
 * Question 2.2 — does an index exist that matches the filter, or one that only
 * partly fits and is quietly ignored?
 *
 * The board list filters with:
 *     $or: [ {userId}, {"members.userId"} ]
 *
 * A reasonable-looking instinct is "two fields, so build one compound index."
 * This script tests that instinct against three index layouts and prints the
 * plan MongoDB actually picked for each.
 *
 *   node scripts/or-index-experiment.js --email you@example.com
 *
 * Leaves the two single-field indexes in place when it finishes.
 */

require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const User = require("../src/models/User");
const Board = require("../src/models/Board");

const EMAIL = (() => {
  const i = process.argv.indexOf("--email");
  return i !== -1 ? process.argv[i + 1] : undefined;
})();

async function clearIndexes() {
  const names = (await Board.collection.indexes()).map((i) => i.name);
  for (const n of names) {
    if (n !== "_id_") await Board.collection.dropIndex(n);
  }
}

function summarise(plan) {
  const es = plan.executionStats;
  const stages = [];
  const used = [];
  (function walk(s) {
    if (!s) return;
    stages.push(s.stage);
    if (s.indexName && !used.includes(s.indexName)) used.push(s.indexName);
    if (s.inputStage) walk(s.inputStage);
    if (s.inputStages) s.inputStages.forEach(walk);
  })(es.executionStages);

  return {
    scan: stages.includes("COLLSCAN") ? "COLLSCAN" : "IXSCAN",
    used: used.length ? used.join(" + ") : "none",
    examined: es.totalDocsExamined,
    returned: es.nReturned,
  };
}

async function trial(name, build, query) {
  await clearIndexes();
  await build();
  const idx = (await Board.collection.indexes()).map((i) => i.name).filter((n) => n !== "_id_");
  const r = summarise(await Board.find(query).explain("executionStats"));

  console.log(`\n${name}`);
  console.log(`  indexes present   ${idx.length ? idx.join(", ") : "(none)"}`);
  console.log(`  plan chosen       ${r.scan}`);
  console.log(`  index actually used  ${r.used}`);
  console.log(`  docs examined     ${r.examined}  ->  returned ${r.returned}`);
  return r;
}

async function main() {
  if (!EMAIL) {
    console.error("Pass --email <account>");
    process.exit(1);
  }
  mongoose.set("autoIndex", false);
  await mongoose.connect(process.env.MONGODB_URI);

  const user = await User.findOne({ email: EMAIL.toLowerCase() });
  const query = { $or: [{ userId: user._id }, { "members.userId": user._id }] };
  const total = await Board.countDocuments();

  console.log(`Database ${mongoose.connection.name} — ${total} boards`);
  console.log(`Query    ${JSON.stringify(query)}`);
  console.log("\n" + "=".repeat(66));

  const a = await trial("A · no indexes at all", async () => {}, query);

  const b = await trial(
    "B · ONE COMPOUND index { userId: 1, 'members.userId': 1 }\n    the intuitive choice: two fields, one index",
    () => Board.collection.createIndex({ userId: 1, "members.userId": 1 }),
    query
  );

  const c = await trial(
    "C · TWO SEPARATE indexes { userId } and { members.userId }",
    async () => {
      await Board.collection.createIndex({ userId: 1 });
      await Board.collection.createIndex({ "members.userId": 1 });
    },
    query
  );

  console.log("\n" + "=".repeat(66));
  console.log("\nWhat happened\n");
  console.log(`  A  no index          ${a.scan.padEnd(9)} examined ${a.examined}`);
  console.log(`  B  compound index    ${b.scan.padEnd(9)} examined ${b.examined}`);
  console.log(`  C  two separate      ${c.scan.padEnd(9)} examined ${c.examined}`);

  if (b.scan === "COLLSCAN") {
    console.log(
      `\n  B built an index and gained NOTHING. Identical plan to having no index\n` +
        `  at all. It still pays the write cost on every insert and update.\n\n` +
        `  Reason: each branch of an $or needs its own usable index. A compound\n` +
        `  index on {userId, members.userId} can serve a query on userId (it is\n` +
        `  the leading field) but NOT one on members.userId alone. One branch is\n` +
        `  unservable, so MongoDB abandons the index and scans the collection.`
    );
  }
  console.log("");

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("Failed:", e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
