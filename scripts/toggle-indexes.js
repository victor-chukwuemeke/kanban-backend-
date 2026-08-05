/**
 * Drop or create the Board indexes, so the before/after in question 2.5 can be
 * reproduced on demand rather than depending on when you happened to run it.
 *
 *   node scripts/toggle-indexes.js --drop     remove them  -> gives you BEFORE
 *   node scripts/toggle-indexes.js --create   add them     -> gives you AFTER
 *   node scripts/toggle-indexes.js            just report what exists
 *
 * Never touches _id_, which MongoDB creates and maintains itself.
 */

require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const Board = require("../src/models/Board");

const DROP = process.argv.includes("--drop");
const CREATE = process.argv.includes("--create");

const MANAGED = ["userId_1", "members.userId_1"];

async function list() {
  const idx = await Board.collection.indexes();
  console.log(`  indexes on boards: ${idx.map((i) => i.name).join(", ")}`);
}

async function main() {
  // autoIndex would silently rebuild what we are trying to drop.
  mongoose.set("autoIndex", false);
  await mongoose.connect(process.env.MONGODB_URI);

  console.log(`Database: ${mongoose.connection.name}`);
  await list();

  if (DROP) {
    const existing = (await Board.collection.indexes()).map((i) => i.name);
    for (const name of MANAGED) {
      if (existing.includes(name)) {
        await Board.collection.dropIndex(name);
        console.log(`  dropped ${name}`);
      } else {
        console.log(`  ${name} was not present`);
      }
    }
    console.log("\nState: BEFORE — run scripts/explain.js now.");
    await list();
  } else if (CREATE) {
    await Board.collection.createIndex({ userId: 1 });
    await Board.collection.createIndex({ "members.userId": 1 });
    console.log(`  created ${MANAGED.join(", ")}`);
    console.log("\nState: AFTER — run scripts/explain.js now.");
    await list();
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("Failed:", e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
