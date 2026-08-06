# Queries behind the Board module

Every database query the audited module runs, what triggers it, and the plan MongoDB
chose. Measured against a seeded database of **5,015 boards**, of which 15 belong to the
test user — my real database has 11 boards, far too few for a plan to mean anything.

Raw output for all of these is in [`../audit/`](../audit/).

---

## 1. The board list — the slowest query, and the one that was broken

Runs on `GET /api/boards`, the first request after login.

```js
// src/controllers/board.controller.js
const boards = await Board.find({
  $or: [
    { userId: req.user._id },              // boards I own
    { "members.userId": req.user._id },    // boards I was added to
  ],
});
```

**Before — no indexes on the collection:**

```
plan               COLLSCAN  <- full collection scan
stages             SUBPLAN → COLLSCAN
index used         none
docs examined      5015
docs returned      15
examined:returned  334.3:1
execution time     9 ms
```

**After — two single-field indexes:**

```js
// src/models/Board.js
boardSchema.index({ userId: 1 });
boardSchema.index({ "members.userId": 1 });
```

```
plan               IXSCAN    <- index scan
stages             SUBPLAN → FETCH → OR → IXSCAN → IXSCAN
index used         userId_1 + members.userId_1
docs examined      15
keys examined      30
docs returned      15
examined:returned  1.0:1
execution time     0 ms
```

334 documents examined per document returned, down to 1. The 30 keys for 15 documents is
the cost of `$or` — MongoDB walks both indexes and de-duplicates.

Reproduce: `node scripts/toggle-indexes.js --drop|--create` then `node scripts/explain.js --email <you>`

---

## 2. The index that looks right and does nothing

The instinctive fix for a two-field filter is one compound index. For an `$or` it is
worthless. Three layouts, same query:

| indexes present | plan | docs examined |
|---|---|---|
| none | `COLLSCAN` | 5015 |
| `{ userId: 1, "members.userId": 1 }` | **`COLLSCAN`** | **5015** |
| `{ userId: 1 }` and `{ "members.userId": 1 }` | `IXSCAN` | 15 |

```js
// This one is ignored entirely — identical plan to having no index,
// while still costing a write on every insert and update.
db.boards.createIndex({ userId: 1, "members.userId": 1 })
```

**Why:** every branch of an `$or` needs its own usable index. A compound index on
`{userId, members.userId}` can serve a query on `userId` — the leading field — but not one
on `members.userId` alone. One unservable branch and MongoDB abandons the index for the
whole query.

Reproduce: `node scripts/or-index-experiment.js --email <you>`

---

## 3. Sorting across an `$or`

There is no `.sort()` anywhere in the application, so the board list returns rows in
whatever order the plan produces. Adding the sort you would actually want:

```js
Board.find(query).sort({ createdAt: -1 })
```

```
without sort:  SUBPLAN → FETCH → OR → IXSCAN → IXSCAN
with sort:     SUBPLAN → SORT → FETCH → OR → IXSCAN → IXSCAN
                         ^^^^ in-memory sort, 32 MB hard limit
```

I assumed this could not be indexed away, because two `$or` branches merge into something
no single index orders. That was wrong:

```js
db.boards.createIndex({ userId: 1, createdAt: -1 })
db.boards.createIndex({ "members.userId": 1, createdAt: -1 })
```

```
SUBPLAN → FETCH → SORT_MERGE → IXSCAN → IXSCAN
                  ^^^^^^^^^^ merges two already-sorted streams, no in-memory sort
```

The filter-then-sort rule holds even across an `$or`, provided each branch gets its own
index with the sort field trailing.

---

## 4. Permission check — runs before every single request

```js
// src/middleware/role.js
const board = await Board.findById(req.params.boardId);
```

```
plan               EXPRESS_IXSCAN
index used         _id_
docs examined      1
execution time     0 ms
```

Already optimal — `_id` is indexed automatically. Included because an audit that finds
problems everywhere is less believable than one that doesn't. Its cost is not the plan; it
is that a whole board document is loaded before *any* operation, including writes.

---

## 5. The write path — a card move

```js
// src/controllers/task.controller.js
task.status = newStatus;
sourceColumn.tasks.pull(taskId);
destColumn.tasks.push(task);
await board.save();          // -> boards.updateOne
```

Mongoose emits an optimistic-concurrency guard because subdocument arrays are modified:

```js
db.boards.updateOne(
  { _id: ObjectId("..."), __v: 58 },   // <- version guard
  { $set: { ... }, $inc: { __v: 1 } }
)
```

Two overlapping requests both read `__v: 58`, both mutate their own copy, and the second
matches zero documents:

```
VersionError: No matching document found for id "6a71d92e..." version 58
              modifiedPaths "columns, columns.0, columns.0.tasks, columns.1, columns.1.tasks"
```

Six unrelated cards moved simultaneously → **2 of 6 failed**, surfacing as untyped `500`s.

Reproduce: `node scripts/concurrency-test.js`

---

## 6. Profile fan-out — the same missing index

```js
// src/utils/avatarSync.js
await Board.updateMany(
  { "members.userId": userId },
  { $set: { "members.$.avatar": newAvatarUrl } }
);
```

Same filter as the board list, so it had the same problem and was fixed by the same index:

| | before | after |
|---|---|---|
| plan | `COLLSCAN` | `IXSCAN` |
| docs examined | 5015 | 15 |

One index, two queries fixed.

---

## 7. Authentication — the most-executed query in the system

```js
// src/middleware/auth.js
const user = await User.findById(decoded.id);
```

Measured **1,369 executions against 0 writes** across a 963-request session — the highest
read-to-write ratio of anything in the app.

Roughly 406 of those were a defect. Board, task and member routes are all mounted at
`/api/boards`, and each router registered `authenticate`. Express runs the middleware of
every matching router until one handles the route:

```
1 x users.findOne   GET   /api/boards            (1st router)
2 x users.findOne   PATCH /:id/tasks/:t/status   (2nd router)
3 x users.findOne   PUT   /:id/members/:m        (3rd router)
```

Fixed by making the middleware idempotent — `if (req.user) return next();` — which keeps
each router self-protecting while removing the redundant round trip. Now 1 across all
three.

---

## 8. An N+1, in signup

```js
// src/controllers/auth.controller.js
const pendingInvites = await PendingInvite.find({ email: user.email });  // 1 query
for (const invite of pendingInvites) {
  await Board.findByIdAndUpdate(invite.boardId, { $push: { members: {...} } });  // + N
}
```

Sequential `await` inside a loop: three pending invites means four queries, forty means
forty-one, each paying a full network round trip. A single `Board.bulkWrite()` would do it
in one.

Distinct from the hot path, which is *chatty* but fixed — three round trips regardless of
data size. Fixed chattiness is a constant tax; N+1 grows with the data.

---

## 9. Pagination — measured, not implemented

The application has no `.skip()`, `.limit()` or page parameter anywhere. Measuring what
OFFSET would cost if added the obvious way:

```js
Board.find({}).skip(n).limit(20)
```

| page | skip | examined | returned |
|---|---|---|---|
| 1 | 0 | 20 | 20 |
| 26 | 500 | 520 | 20 |
| 101 | 2000 | 2020 | 20 |
| 251 | 5000 | **5015** | 15 |

Against keyset on the same data:

```js
Board.find({ _id: { $gt: lastSeenId } }).sort({ _id: 1 }).limit(20)
```

**20 examined on every page, at every depth.** Flat instead of linear.

The larger finding is that pagination is not the bottleneck — projection is. For a user in
5,000 boards the unpaginated list returns **32.1 MB in 18.4 seconds** to render a sidebar
of names. `.select("name")` takes it to 297 KB, **111× smaller**.

Reproduce: `node scripts/pagination.js --email <you>`

---

## 10. Index usage audit

```js
db.users.aggregate([{ $indexStats: {} }])
```

```
users (2 documents)
       0 reads   username_1  [unique]   <- never used to serve a read
       9 reads   email_1     [unique]
```

`username_1` serves no query — users are looked up by email or `_id`, never by username.
But it is a **unique constraint**, not a performance index: dropping it lets two people
register the same username. An index with zero reads is not automatically dead weight,
because indexes do two jobs and `$indexStats` measures only one.

Caveat: `boards._id_` also reports 0 reads despite `requireRole` calling `findById`
constantly, which suggests the `EXPRESS_IXSCAN` fast path does not increment the counter.
The instrument is partly unreliable.

Reproduce: `node scripts/indexes.js`

---

## Indexes added by this audit

```js
// src/models/Board.js
boardSchema.index({ userId: 1 });
boardSchema.index({ "members.userId": 1 });
```

Pre-existing, unchanged:

| collection | index | purpose |
|---|---|---|
| `users` | `email_1` (unique) | login, signup, invite lookup |
| `users` | `username_1` (unique) | constraint only — serves no query |
| `pendinginvites` | `email_1_boardId_1` (unique) | constraint |
| `pendinginvites` | `token_1` (unique) | constraint |
| `pendinginvites` | `expiresAt_1` (TTL) | expiry, not reads |
