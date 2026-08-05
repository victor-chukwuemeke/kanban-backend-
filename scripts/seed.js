/**
 * Seed volume so query plans mean something.
 *
 * A collection scan over 12 boards is indistinguishable from an index scan —
 * both are instant. You need thousands of documents before COLLSCAN actually
 * looks like COLLSCAN in executionStats.
 *
 * Every seeded board is named with the SEED_TAG prefix so it can be removed
 * cleanly. Nothing else is touched.
 *
 *   node scripts/seed.js --email you@example.com          # create
 *   node scripts/seed.js --email you@example.com --clean  # remove
 *
 * Options: --boards 5000   how many boards to create
 *          --tasks 15      tasks per board
 */

require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../src/models/User");
const Board = require("../src/models/Board");

const SEED_TAG = "[seed]";
const SEED_OWNER_EMAIL = "seed-owner@example.com";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const CLEAN = process.argv.includes("--clean");
const EMAIL = arg("email");
const BOARD_COUNT = Number(arg("boards", 5000));
const TASKS_PER_BOARD = Number(arg("tasks", 15));

const COLUMNS = ["Todo", "Doing", "Done"];
const TAGS = ["technical", "concept", "design", "blocker", "marketing", "deployment", "documentation"];

function buildBoard(owner, i) {
  const columns = COLUMNS.map((name) => ({ name, tasks: [] }));

  for (let t = 0; t < TASKS_PER_BOARD; t++) {
    const col = columns[t % columns.length];
    col.tasks.push({
      title: `Task ${t + 1} on board ${i + 1}`,
      description: "Seeded task used for query-plan measurement.",
      status: col.name,
      tag: TAGS[t % TAGS.length],
      assignees: [],
      subtasks: [
        { title: "First step", isCompleted: t % 2 === 0 },
        { title: "Second step", isCompleted: false },
      ],
    });
  }

  // Seeded boards belong to a synthetic user, NOT to the account under test.
  // That is the realistic shape: your user belongs to a handful of boards while
  // the collection holds thousands. If the test account owned everything, the
  // board-list query would return every document it examined and the scan would
  // look harmless.
  return {
    name: `${SEED_TAG} Board ${i + 1}`,
    userId: owner._id,
    members: [
      { userId: owner._id, email: owner.email, username: owner.username, role: "owner", avatar: null },
    ],
    columns,
  };
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set. Copy server/.env to the repo root.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to ${mongoose.connection.name}`);

  if (CLEAN) {
    const { deletedCount } = await Board.deleteMany({
      name: { $regex: `^\\${SEED_TAG}` },
    });
    console.log(`Removed ${deletedCount} seeded boards.`);
    await mongoose.disconnect();
    return;
  }

  if (!EMAIL) {
    console.error("Pass --email <the account you will log in as>");
    process.exit(1);
  }

  const subject = await User.findOne({ email: EMAIL.toLowerCase() });
  if (!subject) {
    console.error(`No user with email ${EMAIL}. Sign up first, then re-run.`);
    process.exit(1);
  }

  // The synthetic owner of every seeded board. Keeps the account under test
  // belonging to only its own real boards.
  let owner = await User.findOne({ email: SEED_OWNER_EMAIL });
  if (!owner) {
    owner = await User.create({
      username: "seed-owner",
      email: SEED_OWNER_EMAIL,
      passwordHash: "not-a-real-account",
    });
  }

  const existing = await Board.countDocuments();
  console.log(`Boards currently in collection: ${existing}`);
  console.log(`Creating ${BOARD_COUNT} boards x ${TASKS_PER_BOARD} tasks...`);

  const BATCH = 500;
  let created = 0;
  for (let start = 0; start < BOARD_COUNT; start += BATCH) {
    const size = Math.min(BATCH, BOARD_COUNT - start);
    const docs = Array.from({ length: size }, (_, k) => buildBoard(owner, start + k));
    await Board.insertMany(docs, { ordered: false });
    created += size;
    process.stdout.write(`\r  ${created}/${BOARD_COUNT}`);
  }

  const total = await Board.countDocuments();
  const stats = await mongoose.connection.db.command({ collStats: "boards" });
  const yours = await Board.countDocuments({
    $or: [{ userId: subject._id }, { "members.userId": subject._id }],
  });

  console.log(`\n\nDone.`);
  console.log(`  boards in collection: ${total}`);
  console.log(`  belonging to ${EMAIL}: ${yours}   <- what the board list must find`);
  console.log(`  collection size:      ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  average document:     ${(stats.avgObjSize / 1024).toFixed(1)} KB`);
  console.log(`\nRemove later with:  node scripts/seed.js --email ${EMAIL} --clean`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("\nSeed failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
