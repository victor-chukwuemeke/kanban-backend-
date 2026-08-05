/**
 * Question 2.3 — what OFFSET pagination costs at depth, and what keyset changes.
 *
 * This app has no pagination at all, so this measures what it WOULD cost if the
 * obvious implementation were added, and compares it against the keyset
 * alternative on the same data.
 *
 *   node scripts/pagination.js --email you@example.com
 *
 * Also measures the payload the board list returns today, since "no pagination"
 * is only a problem in proportion to how much comes back.
 */

require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const User = require("../src/models/User");
const Board = require("../src/models/Board");

const EMAIL = (() => {
  const i = process.argv.indexOf("--email");
  return i !== -1 ? process.argv[i + 1] : undefined;
})();

const PAGE = 20;
const DEPTHS = [0, 500, 2000, 5000];

async function measure(cursor) {
  const plan = await cursor.explain("executionStats");
  const es = plan.executionStats;
  return { examined: es.totalDocsExamined, returned: es.nReturned, ms: es.executionTimeMillis };
}

async function main() {
  if (!EMAIL) {
    console.error("Pass --email <account>");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);

  const user = await User.findOne({ email: EMAIL.toLowerCase() });
  const total = await Board.countDocuments();

  // ---- What the board list returns today, unpaginated ---------------------
  const boards = await Board.find({
    $or: [{ userId: user._id }, { "members.userId": user._id }],
  });
  const bytes = Buffer.byteLength(JSON.stringify(boards));
  const tasks = boards.reduce(
    (n, b) => n + b.columns.reduce((m, c) => m + c.tasks.length, 0),
    0
  );

  console.log(`Boards in collection: ${total}\n`);
  console.log("─".repeat(66));
  console.log("GET /api/boards today — no pagination, no projection");
  console.log("─".repeat(66));
  console.log(`  boards returned   ${boards.length}`);
  console.log(`  tasks inside them ${tasks}`);
  console.log(`  response payload  ${(bytes / 1024).toFixed(1)} KB`);
  console.log(`  per board         ${(bytes / 1024 / boards.length).toFixed(1)} KB`);
  console.log(
    `\n  Every task and subtask ships to render a sidebar list of names.`
  );
  console.log(
    `  At ${total} boards that response would be ~${((bytes / boards.length) * total / 1024 / 1024).toFixed(0)} MB.`
  );

  // ---- OFFSET pagination at depth ----------------------------------------
  console.log(`\n${"─".repeat(66)}`);
  console.log(`OFFSET pagination — .skip(n).limit(${PAGE}) over all boards`);
  console.log("─".repeat(66));
  console.log(`  ${"page".padStart(6)}${"skip".padStart(8)}${"examined".padStart(11)}${"returned".padStart(10)}${"time".padStart(8)}`);

  const offsets = [];
  for (const skip of DEPTHS) {
    const r = await measure(Board.find({}).skip(skip).limit(PAGE));
    offsets.push({ skip, ...r });
    console.log(
      `  ${String(skip / PAGE + 1).padStart(6)}${String(skip).padStart(8)}` +
        `${String(r.examined).padStart(11)}${String(r.returned).padStart(10)}${(r.ms + "ms").padStart(8)}`
    );
  }

  const first = offsets[0], last = offsets[offsets.length - 1];
  console.log(
    `\n  Page 1 examines ${first.examined} to return ${first.returned}.` +
      `\n  Page ${last.skip / PAGE + 1} examines ${last.examined} to return ${last.returned}` +
      ` — ${last.examined - last.returned} documents read and thrown away.`
  );

  // ---- Keyset pagination on the same data --------------------------------
  console.log(`\n${"─".repeat(66)}`);
  console.log(`KEYSET pagination — .find({_id: {$gt: lastSeen}}).limit(${PAGE})`);
  console.log("─".repeat(66));
  console.log(`  ${"page".padStart(6)}${"examined".padStart(11)}${"returned".padStart(10)}${"time".padStart(8)}`);

  let cursorId = null;
  for (let page = 1; page <= DEPTHS.length; page++) {
    const q = cursorId ? { _id: { $gt: cursorId } } : {};
    const r = await measure(Board.find(q).sort({ _id: 1 }).limit(PAGE));
    console.log(
      `  ${String(page).padStart(6)}${String(r.examined).padStart(11)}${String(r.returned).padStart(10)}${(r.ms + "ms").padStart(8)}`
    );
    // advance the cursor by the same number of pages the OFFSET test jumped
    const jump = DEPTHS[page] !== undefined ? DEPTHS[page] : 0;
    if (jump) {
      const at = await Board.find({}).sort({ _id: 1 }).skip(jump - 1).limit(1).select("_id");
      cursorId = at[0]?._id;
    }
  }

  console.log(
    `\n  Constant. Keyset never walks past rows it has already served —` +
      `\n  it jumps straight into the index at the last id it saw.`
  );

  console.log(`\n${"─".repeat(66)}`);
  console.log("Caveat: this app embeds tasks INSIDE board documents, so neither");
  console.log("technique paginates tasks. Paginating an array needs $slice or a");
  console.log("schema change — that limit is structural, not a missing feature.");
  console.log("");

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("Failed:", e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
