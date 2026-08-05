/**
 * Read/write ratio instrumentation.
 *
 * Answers "what is the read-to-write ratio on this endpoint" with a measured
 * number instead of a guess. Counts two different things, because they differ:
 *
 *   - HTTP level: what clients ask for.
 *   - Database level: what MongoDB actually executes. Every write endpoint runs
 *     authenticate (User.findById) and requireRole (Board.findById) first, so a
 *     single client write costs two reads plus one write at the database.
 *
 * Off unless METRICS=1. Enable locally, use the app normally for a while, then
 * GET /api/metrics. Add ?reset=1 to zero the counters before a clean run.
 */

const mongoose = require("mongoose");

const READ_OPS = new Set([
  "find",
  "findOne",
  "countDocuments",
  "estimatedDocumentCount",
  "distinct",
  "aggregate",
]);

const state = {
  startedAt: new Date().toISOString(),
  http: { reads: 0, writes: 0, preflight: 0, byRoute: {} },
  db: { reads: 0, writes: 0, byOp: {} },
};

/**
 * OPTIONS is a CORS preflight, not application traffic. The browser sends one
 * before every non-simple cross-origin request, so counting them as writes
 * roughly doubles the write tally and halves the ratio. They never reach the
 * database. Tracked separately so the cost stays visible without distorting
 * the read-to-write number.
 */
function classify(method) {
  if (method === "OPTIONS") return "preflight";
  if (method === "GET" || method === "HEAD") return "read";
  return "write";
}

function normalizePath(url) {
  return url
    .split("?")[0]
    .replace(/\/[a-f0-9]{24}(?=\/|$)/gi, "/:id");
}

function countDbOps() {
  mongoose.set("debug", (collection, method) => {
    const key = `${collection}.${method}`;
    state.db.byOp[key] = (state.db.byOp[key] || 0) + 1;
    if (READ_OPS.has(method)) state.db.reads++;
    else state.db.writes++;
  });
}

// Keep a bounded sample of per-request durations so percentiles can be computed
// from real traffic. An average would hide the tail, and the tail is the thing
// users actually experience.
const MAX_SAMPLES = 5000;

function httpCounter(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    if (req.path.startsWith("/api/metrics")) return;

    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const kind = classify(req.method);
    const key = `${req.method} ${normalizePath(req.originalUrl)}`;
    const entry = state.http.byRoute[key] || { count: 0, kind, samples: [] };
    entry.count++;
    if (entry.samples.length < MAX_SAMPLES) entry.samples.push(ms);
    state.http.byRoute[key] = entry;

    if (kind === "read") state.http.reads++;
    else if (kind === "write") state.http.writes++;
    else state.http.preflight++;
  });
  next();
}

/**
 * Percentiles from a sample set. p99.9 needs on the order of a thousand samples
 * before it means anything — below that it is just the slowest request wearing a
 * more impressive label — so it is reported as null until there are enough.
 */
function percentiles(samples) {
  if (!samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
  const round = (n) => Math.round(n * 10) / 10;

  return {
    n: s.length,
    min: round(s[0]),
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    p999: s.length >= 1000 ? round(at(99.9)) : null,
    max: round(s[s.length - 1]),
    mean: round(s.reduce((a, b) => a + b, 0) / s.length),
    p999Note: s.length >= 1000 ? undefined : `need >=1000 samples, have ${s.length}`,
  };
}

function ratio(reads, writes) {
  if (writes === 0) return reads === 0 ? "0:0" : `${reads}:0 (no writes yet)`;
  return `${(reads / writes).toFixed(2)}:1`;
}

function report(req, res) {
  if (req.query.reset) {
    state.http = { reads: 0, writes: 0, preflight: 0, byRoute: {} };
    state.db = { reads: 0, writes: 0, byOp: {} };
    state.startedAt = new Date().toISOString();
    return res.json({ message: "counters reset", startedAt: state.startedAt });
  }

  const sortByCount = (obj) =>
    Object.fromEntries(
      Object.entries(obj).sort((a, b) => {
        const av = typeof a[1] === "number" ? a[1] : a[1].count;
        const bv = typeof b[1] === "number" ? b[1] : b[1].count;
        return bv - av;
      })
    );

  res.json({
    since: state.startedAt,
    connection: {
      database: mongoose.connection.name || "(not connected)",
      host: mongoose.connection.host || "(not connected)",
    },
    http: {
      reads: state.http.reads,
      writes: state.http.writes,
      readToWrite: ratio(state.http.reads, state.http.writes),
      corsPreflight: state.http.preflight,
      byRoute: Object.fromEntries(
        Object.entries(state.http.byRoute)
          .sort((a, b) => b[1].count - a[1].count)
          .map(([k, v]) => [
            k,
            { count: v.count, kind: v.kind, latencyMs: percentiles(v.samples) },
          ])
      ),
    },
    database: {
      reads: state.db.reads,
      writes: state.db.writes,
      readToWrite: ratio(state.db.reads, state.db.writes),
      byOp: sortByCount(state.db.byOp),
    },
  });
}

function attachMetrics(app) {
  if (process.env.METRICS !== "1") return false;
  countDbOps();
  app.use(httpCounter);
  app.get("/api/metrics", report);
  return true;
}

module.exports = attachMetrics;
