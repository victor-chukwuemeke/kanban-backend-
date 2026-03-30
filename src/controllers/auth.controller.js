const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Board = require("../models/Board");
const PendingInvite = require("../models/PendingInvite");
const cloudinary = require("../config/cloudinary");
const syncAvatarAcrossBoards = require("../utils/avatarSync");

function generateToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

exports.signup = async (req, res) => {
  try {
    const { username, email, password } = req.body;

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: "Email already in use" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ username, email, passwordHash });
    const token = generateToken(user._id);

    // Process any pending board invitations for this email
    const pendingInvites = await PendingInvite.find({ email: user.email });
    if (pendingInvites.length > 0) {
      for (const invite of pendingInvites) {
        await Board.findByIdAndUpdate(invite.boardId, {
          $push: {
            members: {
              userId: user._id,
              email: user.email,
              username: user.username,
              role: invite.role,
              avatar: user.avatar,
            },
          },
        });
      }
      await PendingInvite.deleteMany({ email: user.email });
    }

    res.status(201).json({
      user: { id: user._id, username: user.username, email: user.email, avatar: user.avatar },
      token,
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = generateToken(user._id);

    res.json({
      user: { id: user._id, username: user.username, email: user.email, avatar: user.avatar },
      token,
    });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

exports.logout = async (_req, res) => {
  res.json({ message: "Logged out successfully" });
};

exports.getMe = async (req, res) => {
  res.json({
    user: {
      id: req.user._id,
      username: req.user.username,
      email: req.user.email,
      avatar: req.user.avatar,
    },
  });
};

exports.updateMe = async (req, res) => {
  try {
    const { username, email } = req.body;
    const updates = {};

    if (username) updates.username = username;
    if (email) {
      const existing = await User.findOne({
        email: email.toLowerCase(),
        _id: { $ne: req.user._id },
      });
      if (existing) {
        return res.status(409).json({ error: "Email already in use" });
      }
      updates.email = email.toLowerCase();
    }

    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true });

    if (username) {
      const Board = require("../models/Board");
      await Board.updateMany(
        { "members.userId": req.user._id },
        { $set: { "members.$.username": username } }
      );
    }

    res.json({
      user: { id: user._id, username: user.username, email: user.email, avatar: user.avatar },
    });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

exports.updateAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided" });
    }

    const b64 = req.file.buffer.toString("base64");
    const dataURI = `data:${req.file.mimetype};base64,${b64}`;

    const result = await cloudinary.uploader.upload(dataURI, {
      folder: "kanbanflow/avatars",
      transformation: [{ width: 200, height: 200, crop: "fill", gravity: "face" }],
    });

    const avatarUrl = result.secure_url;

    await User.findByIdAndUpdate(req.user._id, { avatar: avatarUrl });
    await syncAvatarAcrossBoards(req.user._id, avatarUrl);

    res.json({ avatar: avatarUrl });
  } catch (error) {
    res.status(500).json({ error: "Failed to upload avatar" });
  }
};
