const crypto = require("crypto");
const User = require("../models/User");
const PendingInvite = require("../models/PendingInvite");
const getTransporter = require("../config/mailer");
const { inviteEmail } = require("../utils/emailTemplates");

function removeAssigneesFromBoard(board, userId) {
  const idStr = userId.toString();
  board.columns.forEach((col) => {
    col.tasks.forEach((task) => {
      task.assignees = task.assignees.filter(
        (id) => id.toString() !== idStr
      );
    });
  });
}

exports.inviteMember = async (req, res) => {
  try {
    const board = req.board;
    const { email, role } = req.body;

    if (!["editor", "viewer"].includes(role)) {
      return res.status(400).json({ error: "Role must be editor or viewer" });
    }

    if (email.toLowerCase() === req.user.email) {
      return res.status(400).json({ error: "Cannot invite yourself" });
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    if (user) {
      const alreadyMember = board.members.find(
        (m) => m.userId.toString() === user._id.toString()
      );
      if (alreadyMember) {
        return res.status(409).json({ error: "User is already a member" });
      }

      board.members.push({
        userId: user._id,
        email: user.email,
        username: user.username,
        role,
        avatar: user.avatar,
      });

      await board.save();
      return res.json({ message: "Member added successfully", board });
    }

    // User not registered — create pending invite and send email
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await PendingInvite.findOneAndUpdate(
      { email: email.toLowerCase(), boardId: board._id },
      { role, token, invitedBy: req.user._id, expiresAt },
      { upsert: true, new: true }
    );

    const signupUrl = `${process.env.FRONTEND_URL}/signup?invite=${token}`;
    const { subject, html } = inviteEmail({
      boardName: board.name,
      inviterName: req.user.username,
      signupUrl,
    });

    await getTransporter().sendMail({
      from: process.env.SMTP_FROM,
      to: email.toLowerCase(),
      subject,
      html,
    });

    res.json({ message: "Invitation email sent successfully" });
  } catch (error) {
    console.error("Invite error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

exports.changeMemberRole = async (req, res) => {
  try {
    const board = req.board;
    const { memberId } = req.params;
    const { role } = req.body;

    if (!["editor", "viewer"].includes(role)) {
      return res.status(400).json({ error: "Role must be editor or viewer" });
    }

    const member = board.members.id(memberId);
    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    if (member.role === "owner") {
      return res.status(400).json({ error: "Cannot change the owner's role" });
    }

    member.role = role;
    await board.save();
    res.json({ message: "Member role updated successfully", board });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

exports.removeMember = async (req, res) => {
  try {
    const board = req.board;
    const { memberId } = req.params;

    const member = board.members.id(memberId);
    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    if (member.role === "owner") {
      return res.status(400).json({ error: "Cannot remove the owner" });
    }

    removeAssigneesFromBoard(board, member.userId);
    board.members.pull(memberId);

    await board.save();
    res.json({ message: "Member removed successfully", board });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

exports.leaveBoard = async (req, res) => {
  try {
    const board = req.board;
    const userId = req.user._id.toString();

    if (board.userId.toString() === userId) {
      return res.status(400).json({ error: "Owner cannot leave the board. Transfer ownership or delete the board." });
    }

    const member = board.members.find(
      (m) => m.userId.toString() === userId
    );
    if (!member) {
      return res.status(404).json({ error: "You are not a member of this board" });
    }

    removeAssigneesFromBoard(board, req.user._id);
    board.members.pull(member._id);

    await board.save();
    res.json({ message: "Left the board successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};
