const express = require("express");
const cors = require("cors");
const path = require("path");
const { apiReference } = require("@scalar/express-api-reference");

const authRoutes = require("./routes/auth.routes");
const boardRoutes = require("./routes/board.routes");
const taskRoutes = require("./routes/task.routes");
const memberRoutes = require("./routes/member.routes");

const attachMetrics = require("./middleware/metrics");

const app = express();

// Read/write ratio instrumentation — no-op unless METRICS=1
attachMetrics(app);

// Middleware
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3002").split(",");
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// Routes
app.use("/api/auth", authRoutes);
app.use("/api/boards", boardRoutes);
app.use("/api/boards", taskRoutes);
app.use("/api/boards", memberRoutes);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// API Docs (Scalar)
app.get("/api/docs/openapi.json", (_req, res) => {
  res.sendFile(path.join(__dirname, "docs", "openapi.json"));
});

app.use(
  "/api/docs",
  apiReference({
    spec: {
      url: "/api/docs/openapi.json",
    },
    theme: "purple",
  })
);

// Unmatched API routes — without this Express replies with an HTML error page,
// which a JSON client cannot parse.
app.use("/api", (req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl}` });
});

// Global error handler.
// Previously any error carrying a .message was reported as 400, which blamed the
// client for server-side faults and made the 500 branch unreachable. Only errors
// that actually declare a client-facing status get one.
app.use((err, _req, res, _next) => {
  if (err.name === "MulterError") {
    return res.status(400).json({ error: err.message });
  }

  const status = err.statusCode || err.status;
  if (status && status >= 400 && status < 500) {
    return res.status(status).json({ error: err.message });
  }

  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
