/**
 * Index inventory and usage — evidence for question 2.4, "the index nobody reads".
 *
 * $indexStats reports how many times each index has actually been used to serve
 * a query since the mongod process last started. An index with 0 accesses is
 * costing a write on every insert and update while returning nothing.
 *
 *   node scripts/indexes.js
 *
 * Caveat worth stating in your write-up: these counters reset when the server
 * restarts, and they only count query usage. An index with 0 reads may still be
 * earning its keep as a uniqueness constraint — that is a different job, and
 * dropping it would change behaviour, not just performance.
 */

require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");

require("../src/models/Board");
require("../src/models/User");
require("../src/models/PendingInvite");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  console.log(`Database: ${mongoose.connection.name}\n`);

  const collections = (await db.listCollections().toArray())
    .map((c) => c.name)
    .sort();

  const unused = [];

  for (const name of collections) {
    const coll = db.collection(name);
    const stats = await coll.aggregate([{ $indexStats: {} }]).toArray();
    const defs = await coll.indexes();
    const docs = await coll.countDocuments();

    console.log(`${"─".repeat(64)}`);
    console.log(`${name}  (${docs} documents)`);
    console.log(`${"─".repeat(64)}`);

    for (const s of stats.sort((a, b) => a.accesses.ops - b.accesses.ops)) {
      const def = defs.find((d) => d.name === s.name) || {};
      const flags = [];
      if (def.unique) flags.push("unique");
      if (def.expireAfterSeconds !== undefined) flags.push("TTL");

      const ops = Number(s.accesses.ops);
      const marker = ops === 0 ? "  <- never used to serve a read" : "";

      console.log(
        `  ${String(ops).padStart(6)} reads   ${s.name}` +
          `${flags.length ? "  [" + flags.join(", ") + "]" : ""}${marker}`
      );

      if (ops === 0 && s.name !== "_id_") {
        unused.push({ collection: name, index: s.name, flags });
      }
    }
    console.log("");
  }

  console.log(`${"─".repeat(64)}`);
  console.log("Indexes with zero reads");
  console.log(`${"─".repeat(64)}`);
  if (!unused.length) {
    console.log("  none");
  } else {
    for (const u of unused) {
      const why = u.flags.includes("unique")
        ? "enforces uniqueness — dropping it changes behaviour, not just speed"
        : u.flags.includes("TTL")
        ? "drives expiry — not used for reads by design"
        : "no reads and no constraint job — a candidate to drop";
      console.log(`  ${u.collection}.${u.index}`);
      console.log(`      ${why}`);
    }
  }
  console.log("");

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("Failed:", e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
