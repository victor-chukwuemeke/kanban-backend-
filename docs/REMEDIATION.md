# Remediation plan

What I would do about each open finding, what it costs, and why it hasn't been done yet.
Four findings were fixed during the audit; the rest are here.

Ordered by value against effort, not by severity — the cheapest wins are first because
they are the ones that would actually get shipped.

| # | finding | fix | effort | risk |
|---|---|---|---|---|
| 1 | Board list ships 32 MB | add a projection | 1 line | low |
| 2 | `members[].email` never syncs | one sync helper for all 3 fields | ~15 lines | low |
| 3 | `VersionError` returns bare `500` | map it to `409` + client retry | ~10 lines | low |
| 4 | SMTP blocks the request ~2 s | enable connection pooling | 2 lines | low |
| 5 | Board order is unspecified | explicit sort + extend indexes | ~5 lines | low |
| 6 | N+1 in signup | `bulkWrite` | ~10 lines | low |
| 7 | Consistency defaults never chosen | pass them explicitly | 4 lines | none |
| 8 | User re-fetched on every request | trust the JWT claims | half a day | medium |
| 9 | Task `status` stored twice | single source of truth | 1–2 days | high |
| 10 | Board is one document — 16 MB ceiling | reference tasks instead of embedding | 1–2 weeks | high |

---

## 1. Board list ships every task and subtask

**Problem.** `GET /api/boards` returns full board documents to render a sidebar of names.
For a user in 5,000 boards that is **32.1 MB in 18.4 seconds**.

**Fix.**

```js
// src/controllers/board.controller.js
const boards = await Board.find({
  $or: [{ userId: req.user._id }, { "members.userId": req.user._id }],
}).select("name userId members createdAt");
```

Measured: 32.1 MB → 297 KB. **111× smaller.**

**Cost.** Check what the frontend sidebar actually reads first. If it counts tasks per
board, that count has to come from an aggregation instead — still far cheaper than
shipping every task.

**Why not yet.** Needs a frontend change alongside it, so the two have to ship together.

---

## 2. `members[].email` is never re-synchronised

**Problem.** `board.members[]` caches each user's `email`, `username` and `avatar`. Three
fields, three different mechanisms: `avatar` via a helper, `username` inline in
`updateMe`, `email` nowhere. Change your email and every board keeps the old one
permanently — there is no TTL to correct it.

**Fix.** One helper, used by every write path that touches a user's public fields.

```js
// src/utils/userSync.js
async function syncUserAcrossBoards(userId, fields) {
  const allowed = ["email", "username", "avatar"];
  const $set = {};
  for (const key of allowed) {
    if (fields[key] !== undefined) $set[`members.$[m].${key}`] = fields[key];
  }
  if (!Object.keys($set).length) return;

  await Board.updateMany(
    { "members.userId": userId },
    { $set },
    { arrayFilters: [{ "m.userId": userId }] }
  );
}
```

Then `updateMe` and `updateAvatar` both call it, and the inline `Board.updateMany` in
`auth.controller.js` goes away.

**Cost.** Every profile edit fans out across all boards that user belongs to. That query
now uses `members.userId_1`, so it examines 15 documents rather than 5,015 — this fix is
only affordable *because* the index went in.

**Why not yet.** It is the right fix and should be next. The deeper question — whether
copying user fields into boards is worth it at all — is finding 10.

---

## 3. `VersionError` surfaces as an untyped `500`

**Problem.** Two people moving different cards on the same board collide. Mongoose rejects
the loser with `VersionError`, which is *correct* — it prevents silent data loss — but the
catch block returns `500 "Server error"`, so the card snaps back with no explanation.

**Fix.**

```js
// src/controllers/task.controller.js — in each catch block
if (error.name === "VersionError") {
  return res.status(409).json({
    error: "This board was changed by someone else. Refreshing.",
    code: "STALE_BOARD",
  });
}
```

**Cost.** The client has to handle `409` by refetching the board and reapplying the move —
**not** by blindly retrying the same request, which would replay against stale state.

**Why not yet.** Needs the frontend retry logic to land at the same time, otherwise the
user sees a clearer error but the same broken outcome.

**What this does not fix.** Contention itself. Every write to a board still serialises on
one document. That is finding 10.

---

## 4. SMTP handshake blocks the invite response

**Problem.** `inviteMember` awaits `sendMail`. The connect-and-handshake alone measures
~2 seconds, and `mailer.js` sets no pooling, so every invite pays it again.

**Fix, cheap version.**

```js
// src/config/mailer.js
transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  pool: true,
  maxConnections: 3,
});
```

Keeps connections warm, so only the first invite after an idle period pays the handshake.

**Fix, proper version — and why I would not rush it.** Moving the send to a queue needs
answers to two questions:

- *What breaks if it runs twice?* Little. The `PendingInvite` write is an upsert, so state
  is idempotent; the invitee gets a duplicate email.
- *What breaks if it never runs?* The invite vanishes and **nobody finds out** — the
  endpoint already returned `200`.

So simply dropping the `await` trades a visible failure for a silent one, which is not an
improvement. A real queue needs retries and a dead-letter path. Pooling gets most of the
latency for none of that risk.

**Why not yet.** Pooling should just go in. The queue is not justified at current volume.

---

## 5. Board list has no explicit ordering

**Problem.** No `.sort()` anywhere, so order is whatever the plan produces. It happens to
be stable today, but MongoDB guarantees nothing without an explicit sort — a plan change
could silently reorder a user's sidebar.

**Fix.**

```js
Board.find(query).sort({ createdAt: -1 })
```

and extend the indexes so the sort is served rather than done in memory:

```js
boardSchema.index({ userId: 1, createdAt: -1 });
boardSchema.index({ "members.userId": 1, createdAt: -1 });
```

Verified: this produces `SORT_MERGE` and the in-memory `SORT` stage disappears.

**Cost.** Replaces the two existing single-field indexes rather than adding to them — the
compound versions serve both purposes.

**Why not yet.** No user has complained, so it is latent rather than live. It is cheap and
should go in with the next batch.

---

## 6. N+1 when processing pending invites

**Problem.** Signup fetches pending invites, then awaits `Board.findByIdAndUpdate` once
per invite, sequentially. Forty invites means forty-one round trips.

**Fix.**

```js
if (pendingInvites.length) {
  await Board.bulkWrite(
    pendingInvites.map((invite) => ({
      updateOne: {
        filter: { _id: invite.boardId },
        update: { $push: { members: { userId: user._id, email: user.email,
                                      username: user.username, role: invite.role,
                                      avatar: user.avatar } } },
      },
    }))
  );
  await PendingInvite.deleteMany({ email: user.email });
}
```

**Cost.** None meaningful. `bulkWrite` is unordered by default, so one failing board does
not block the rest — which is what you want here.

**Why not yet.** Low impact in practice: nobody is invited to forty boards before signing
up. Worth fixing because it is nearly free, not because it hurts today.

---

## 7. Consistency settings were inherited, never chosen

**Problem.** `mongoose.connect(uri)` passes no options, so `readPreference: primary`,
`readConcern: local` and `w: majority` were all defaults. They happen to be right for this
data — task state behaves like an account balance, not a like counter — but nothing
records that as a decision.

**Fix.** State them, so the next person knows they were considered.

```js
// src/config/db.js
await mongoose.connect(process.env.MONGODB_URI, {
  readPreference: "primary",        // reads never lag behind writes
  writeConcern: { w: "majority" },  // survive a primary failover
});
```

**Cost.** None. Behaviour is identical.

**Why not yet.** Pure documentation-as-code. Should go in with the next change to that file.

---

## 8. The user is re-fetched from the database on every request

**Problem.** `authenticate` runs `User.findById` on every authenticated request — measured
at ~963 reads against 0 writes in one session. The JWT is already signed, already verified,
and already carries the user id.

**Fix, in order of preference.**

1. **Stop fetching.** Audit which handlers actually need live user fields. Those that only
   need the id can use `req.auth.id` straight from the token. This removes a round trip
   rather than caching one.
2. **Cache what remains.** In-process `Map`, key `user:<id>`, TTL 30–60 s, **expiry-based
   invalidation** — see [ADR 0001](adr/0001-user-cache-invalidation.md) for why not
   delete-on-write.

**Cost.** Option 1 needs every handler checked. Option 2 accepts up to 60 s of staleness
after a profile change.

**Why not yet.** Requires the consumer audit first. Worth noting that caching *before*
fixing the duplicate-auth bug would have hidden that bug behind cache hits — a cache that
conceals a defect is worse than no cache.

---

## 9. A task's status is stored in two places

**Problem.** Every task has a `status` field *and* lives inside a particular column's
`tasks` array. Two sources of truth for the same fact, with nothing enforcing agreement.
Worse, the two handlers that move tasks disagree about which to trust: `changeStatus`
searches every column, while `updateTask` trusts a `previousStatus` sent by the client.

**Fix.** Pick one and make the other derived.

- **Column membership as truth** — drop the `status` field, derive it from the parent
  column on read. Cannot drift, but every read needs the parent column in scope.
- **`status` as truth** — flatten `columns` to a plain list of names and select tasks by
  `status`. Cleaner, but a bigger change to the read path and the client.

Either way, `updateTask` must stop trusting client-supplied `previousStatus`, and the
route should drop its unused required `oldStatus` field.

**Cost.** A schema migration and matching frontend changes.

**Why not yet.** This is the answer to "what would confuse someone in six months," so it
deserves a proper decision rather than a quick patch. It should get its own ADR.

---

## 10. The whole board is one document

**Problem.** The root cause behind most of the above. `Board → columns[] → tasks[] →
subtasks[]` means the unit of contention is the board, not the task: two people editing
unrelated cards collide. It also caps a board at MongoDB's 16 MB document limit, makes
pagination of tasks impossible without `$slice`, and forces user data to be denormalised
into `members[]` to avoid joins.

**Fix.** Move tasks into their own collection with a `boardId` reference.

**What it buys.** Contention drops to per-task. The 16 MB ceiling disappears. Tasks become
paginable and queryable across boards — "everything assigned to me, due this week" becomes
possible, which it currently is not.

**What it costs.** Reading a board becomes two queries or an aggregation instead of one.
Every task write path is rewritten. A data migration is needed. And the atomicity that
`board.save()` currently provides for free would have to be handled explicitly.

**Why not yet.** This is the largest decision in the codebase and needs its own ADR
weighing both sides. Interestingly, the production database still contains a `tasks`
collection holding 2 documents — evidence that this design was tried before embedding was
adopted. Whatever prompted that switch should be recovered before reversing it.

---

## Already fixed during this audit

| finding | fix |
|---|---|
| Board list was a full collection scan | added `userId` and `members.userId` indexes — 5015 → 15 docs examined |
| `authenticate` ran up to 3× per request | made the middleware idempotent — 3 → 1 lookups |
| Every error with a `.message` returned `400` | honour `err.statusCode`, otherwise `500` |
| Unmatched `/api` routes returned HTML | JSON 404 handler |
