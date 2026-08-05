const mongoose = require("mongoose");

const boardMemberSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  email: { type: String, required: true },
  username: { type: String, required: true },
  role: { type: String, enum: ["owner", "editor", "viewer"], required: true },
  avatar: { type: String, default: null },
  joinedAt: { type: Date, default: Date.now },
});

const subtaskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  isCompleted: { type: Boolean, default: false },
});

const taskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, default: "" },
  status: { type: String, required: true },
  tag: {
    type: String,
    enum: [
      "technical",
      "concept",
      "design",
      "blocker",
      "marketing",
      "deployment",
      "documentation",
      null,
    ],
  },
  assignees: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  startDate: { type: Date, default: null },
  dueDate: { type: Date, default: null },
  subtasks: [subtaskSchema],
  createdAt: { type: Date, default: Date.now },
});

const columnSchema = new mongoose.Schema({
  name: { type: String, required: true },
  tasks: [taskSchema],
});

const boardSchema = new mongoose.Schema({
  name: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  members: [boardMemberSchema],
  columns: [columnSchema],
  createdAt: { type: Date, default: Date.now },
});

// The board list runs $or: [{userId}, {"members.userId"}]. Without both of these
// it is a full collection scan on the busiest read in the app, and the same
// members.userId filter is reused by the avatar fan-out on every profile change.
boardSchema.index({ userId: 1 });
boardSchema.index({ "members.userId": 1 });

boardSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Board", boardSchema);
