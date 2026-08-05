/**
 * Board setup and traffic simulation.
 *
 *   node scripts/session.js --setup
 *       Creates a board with 12 cards and subtasks. Prints the BOARD_ID.
 *
 *   node scripts/session.js --simulate --actions 120
 *       Drives a realistic user session against that board.
 *
 * Why --simulate exists: the read-to-write ratio on this API is decided almost
 * entirely by whether the CLIENT refetches the board after each mutation. Run it
 * both ways and the difference is the finding:
 *
 *   node scripts/session.js --simulate --actions 120              (refetch on)
 *   node scripts/session.js --simulate --actions 120 --no-refetch (refetch off)
 *
 * Use the real frontend instead if you have it — measured beats simulated. This
 * is the fallback, and you should label it as simulated in your write-up.
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:6000";
const TOKEN = process.env.TOKEN;
let BOARD_ID = process.env.BOARD_ID;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const SETUP = process.argv.includes("--setup");
const SIMULATE = process.argv.includes("--simulate");
const REFETCH = !process.argv.includes("--no-refetch");
const ACTIONS = Number(arg("actions", 120));
const CARDS = Number(arg("cards", 12));

if (!TOKEN) {
  console.error("Set TOKEN first. See Phase 0.4 of the runbook.");
  process.exit(1);
}

const headers = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
const COLUMNS = ["Todo", "Doing", "Done"];
const TAGS = ["technical", "concept", "design", "blocker", "marketing", "deployment", "documentation"];

const TITLES = [
  "Wire up login form", "Fix avatar upload on Safari", "Write onboarding copy",
  "Add index to boards collection", "Review PR #42", "Design empty state",
  "Investigate slow board load", "Set up error tracking", "Draft release notes",
  "Refactor role middleware", "Add rate limiting", "Update API docs",
  "Migrate to Node 20", "Audit dependency tree", "Add loading skeletons",
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, json };
}

async function setup() {
  console.log(`Creating board with ${CARDS} cards...\n`);

  const board = await call("POST", "/api/boards", {
    name: "Audit Board",
    columns: COLUMNS,
  });
  if (!board.ok) {
    console.error(`Board creation failed (${board.status}):`, board.json);
    process.exit(1);
  }
  const boardId = board.json.board.id || board.json.board._id;

  let made = 0;
  for (let i = 0; i < CARDS; i++) {
    const status = COLUMNS[i % COLUMNS.length];
    const res = await call("POST", `/api/boards/${boardId}/tasks`, {
      title: TITLES[i % TITLES.length],
      description: "Created for the performance audit.",
      status,
      tag: pick(TAGS),
      subtasks: ["First step", "Second step", "Third step"].slice(0, 2 + (i % 2)),
    });
    if (res.ok) made++;
    else console.error(`  card ${i + 1} failed (${res.status}):`, res.json);
  }

  console.log(`Board created with ${made}/${CARDS} cards.\n`);
  console.log(`  BOARD_ID = ${boardId}\n`);
  console.log(`Set it for the next steps:\n`);
  console.log(`  PowerShell:  $env:BOARD_ID="${boardId}"`);
  console.log(`  Bash:        export BOARD_ID=${boardId}\n`);
}

async function simulate() {
  if (!BOARD_ID) {
    console.error("Set BOARD_ID (printed by --setup).");
    process.exit(1);
  }

  console.log(`Simulating ${ACTIONS} actions · refetch-after-write ${REFETCH ? "ON" : "OFF"}\n`);

  const counts = { boardList: 0, boardOpen: 0, move: 0, toggle: 0, edit: 0, create: 0, refetch: 0, errors: 0 };

  const load = async () => {
    const r = await call("GET", `/api/boards/${BOARD_ID}`);
    if (!r.ok) { counts.errors++; return null; }
    return r.json.board;
  };

  let board = await load();
  if (!board) {
    console.error("Could not load the board. Check BOARD_ID and TOKEN.");
    process.exit(1);
  }
  counts.boardOpen++;

  const allTasks = () =>
    board.columns.flatMap((c) => c.tasks.map((t) => ({ ...t, column: c.name })));

  for (let i = 0; i < ACTIONS; i++) {
    const roll = Math.random();
    const tasks = allTasks();
    const task = tasks.length ? pick(tasks) : null;
    const id = task && (task.id || task._id);

    if (roll < 0.12) {
      await call("GET", "/api/boards");
      counts.boardList++;
      continue;
    }
    if (roll < 0.28) {
      board = (await load()) || board;
      counts.boardOpen++;
      continue;
    }

    // Each branch applies the change to local state as well, so that with
    // --no-refetch the simulator can keep going without reading the board back.
    // That is what an optimistic-update client does.
    const localCol = (name) => board.columns.find((c) => c.name === name);

    if (roll < 0.62 && task) {
      const to = pick(COLUMNS.filter((c) => c !== task.column));
      const r = await call("PATCH", `/api/boards/${BOARD_ID}/tasks/${id}/status`, {
        oldStatus: task.column,
        newStatus: to,
      });
      if (r.ok) {
        counts.move++;
        const from = localCol(task.column);
        const dest = localCol(to);
        const idx = from?.tasks.findIndex((t) => (t.id || t._id) === id);
        if (from && dest && idx > -1) {
          const [moved] = from.tasks.splice(idx, 1);
          moved.status = to;
          dest.tasks.push(moved);
        }
      } else counts.errors++;
    } else if (roll < 0.82 && task && task.subtasks?.length) {
      const sub = pick(task.subtasks);
      const r = await call(
        "PATCH",
        `/api/boards/${BOARD_ID}/tasks/${id}/subtasks/${sub.id || sub._id}`
      );
      if (r.ok) {
        counts.toggle++;
        const live = localCol(task.column)?.tasks.find((t) => (t.id || t._id) === id);
        const ls = live?.subtasks.find((s) => (s.id || s._id) === (sub.id || sub._id));
        if (ls) ls.isCompleted = !ls.isCompleted;
      } else counts.errors++;
    } else if (roll < 0.94 && task) {
      const newTitle = `${task.title} (edited)`;
      const r = await call("PUT", `/api/boards/${BOARD_ID}/tasks/${id}`, {
        title: newTitle,
      });
      if (r.ok) {
        counts.edit++;
        const live = localCol(task.column)?.tasks.find((t) => (t.id || t._id) === id);
        if (live) live.title = newTitle;
      } else counts.errors++;
    } else {
      const status = pick(COLUMNS);
      const r = await call("POST", `/api/boards/${BOARD_ID}/tasks`, {
        title: pick(TITLES),
        status,
        subtasks: ["Step one"],
      });
      if (r.ok) {
        counts.create++;
        localCol(status)?.tasks.push(r.json.task);
      } else counts.errors++;
    }

    // A typical SPA refetches the board after every mutation to resync. That one
    // client-side choice is what actually sets the read-to-write ratio.
    if (REFETCH) {
      board = (await load()) || board;
      counts.refetch++;
    }

    if ((i + 1) % 20 === 0) process.stdout.write(`\r  ${i + 1}/${ACTIONS} actions`);
  }

  console.log(`\n\nSession complete:`);
  for (const [k, v] of Object.entries(counts)) {
    if (v) console.log(`  ${k.padEnd(12)} ${v}`);
  }
  console.log(`\nNow read the ratio:`);
  console.log(`  Invoke-RestMethod ${BASE_URL}/api/metrics | ConvertTo-Json -Depth 5\n`);
}

async function main() {
  if (SETUP) return setup();
  if (SIMULATE) return simulate();
  console.log("Pass --setup or --simulate. See the comment at the top of this file.");
}

main().catch((e) => {
  console.error("\nFailed:", e.message);
  process.exit(1);
});
