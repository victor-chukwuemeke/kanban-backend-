/**
 * Hot-document contention reproduction.
 *
 * Every task write endpoint loads the whole board, mutates it in JS, then calls
 * board.save(). Two requests that overlap read the same version of the document
 * and race to write it back. This script makes that visible.
 *
 * Test A — different cards, same board. The interesting one. The two users touch
 *          completely unrelated tasks in unrelated columns and still collide,
 *          because the unit of contention is the board document, not the task.
 * Test B — same card, two users. The obvious conflict.
 *
 * Usage:
 *   BASE_URL=http://localhost:6000 TOKEN=<jwt> BOARD_ID=<id> node scripts/concurrency-test.js
 *
 * Get a token by logging in, then copy it out of the login response or your
 * browser's network tab. Use a throwaway board — this moves real cards.
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:6000";
const TOKEN = process.env.TOKEN;
const BOARD_ID = process.env.BOARD_ID;
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);

if (!TOKEN || !BOARD_ID) {
  console.error("Set TOKEN and BOARD_ID. See the comment at the top of this file.");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${TOKEN}`,
};

async function getBoard() {
  const res = await fetch(`${BASE_URL}/api/boards/${BOARD_ID}`, { headers });
  if (!res.ok) {
    throw new Error(`GET board failed: ${res.status} ${await res.text()}`);
  }
  const { board } = await res.json();
  return board;
}

async function moveTask(taskId, oldStatus, newStatus) {
  const startedAt = process.hrtime.bigint();
  const res = await fetch(
    `${BASE_URL}/api/boards/${BOARD_ID}/tasks/${taskId}/status`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ oldStatus, newStatus }),
    }
  );
  const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
  let body;
  try {
    body = await res.json();
  } catch {
    body = { error: "unparseable response" };
  }
  return { status: res.status, ms: Math.round(ms), body };
}

function summarise(label, results) {
  const ok = results.filter((r) => r.status === 200);
  const failed = results.filter((r) => r.status !== 200);

  console.log(`\n  ${label}`);
  console.log(`    fired:     ${results.length} concurrent requests`);
  console.log(`    succeeded: ${ok.length}`);
  console.log(`    failed:    ${failed.length}`);

  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log(`    statuses:  ${JSON.stringify(byStatus)}`);

  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(
    `    latency:   min ${latencies[0]}ms · median ${
      latencies[Math.floor(latencies.length / 2)]
    }ms · max ${latencies[latencies.length - 1]}ms`
  );

  if (failed.length) {
    console.log(`    error body: ${JSON.stringify(failed[0].body)}`);
  }
  return { ok: ok.length, failed: failed.length };
}

function countTasks(board) {
  return board.columns.reduce((n, col) => n + col.tasks.length, 0);
}

async function main() {
  const before = await getBoard();
  const columnNames = before.columns.map((c) => c.name);

  console.log(`\nBoard: "${before.name}"`);
  console.log(`Columns: ${columnNames.join(", ")}`);
  console.log(`Tasks: ${countTasks(before)}`);

  const populated = before.columns.filter((c) => c.tasks.length > 0);
  if (populated.length === 0) {
    console.error("\nThis board has no tasks. Add a few cards and re-run.");
    process.exit(1);
  }
  if (columnNames.length < 2) {
    console.error("\nNeed at least two columns to move cards between.");
    process.exit(1);
  }

  // ---- Test A: different cards, same board -------------------------------
  const candidates = [];
  for (const col of before.columns) {
    for (const task of col.tasks) {
      const target = columnNames.find((n) => n !== col.name);
      candidates.push({ id: task.id || task._id, from: col.name, to: target });
      if (candidates.length >= CONCURRENCY) break;
    }
    if (candidates.length >= CONCURRENCY) break;
  }

  console.log(
    `\n─── Test A · ${candidates.length} DIFFERENT cards moved simultaneously ───`
  );
  console.log("    (unrelated tasks — nothing is logically shared but the board)");

  const resultsA = await Promise.all(
    candidates.map((c) => moveTask(c.id, c.from, c.to))
  );
  const a = summarise("Result", resultsA);

  const afterA = await getBoard();
  const lost = countTasks(before) - countTasks(afterA);
  console.log(
    `    tasks before ${countTasks(before)} → after ${countTasks(afterA)}${
      lost !== 0 ? `  ⚠  ${Math.abs(lost)} ${lost > 0 ? "lost" : "gained"}` : "  (none lost)"
    }`
  );

  // ---- Test B: same card, two users --------------------------------------
  const first = candidates[0];
  console.log(`\n─── Test B · the SAME card moved by two users at once ───`);

  const resultsB = await Promise.all([
    moveTask(first.id, first.from, first.to),
    moveTask(first.id, first.from, first.to),
  ]);
  summarise("Result", resultsB);

  // ---- Verdict ------------------------------------------------------------
  console.log(`\n─── What this shows ───`);
  if (a.failed > 0) {
    console.log(
      `    ${a.failed}/${resultsA.length} unrelated card moves failed. The board`
    );
    console.log(`    document is the unit of contention, not the task.`);
    console.log(
      `    Mongoose guards the array writes with __v, so the losers are rejected`
    );
    console.log(`    rather than silently clobbering — but they surface as a bare 500.`);
  } else {
    console.log(`    No collisions this run. The race is real but timing-dependent —`);
    console.log(`    raise CONCURRENCY, or run against the deployed instance where`);
    console.log(`    network latency widens the read-modify-write gap:`);
    console.log(`      CONCURRENCY=20 node scripts/concurrency-test.js`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("\nTest failed:", err.message);
  process.exit(1);
});
