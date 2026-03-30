const mongoose = require("mongoose");

const pendingInviteSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true },
  boardId: { type: mongoose.Schema.Types.ObjectId, ref: "Board", required: true },
  role: { type: String, enum: ["editor", "viewer"], required: true },
  token: { type: String, required: true, unique: true },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  expiresAt: { type: Date, required: true },
});

pendingInviteSchema.index({ email: 1, boardId: 1 }, { unique: true });
pendingInviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("PendingInvite", pendingInviteSchema);
