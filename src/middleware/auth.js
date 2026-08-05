const jwt = require("jsonwebtoken");
const User = require("../models/User");

const authenticate = async (req, res, next) => {
  try {
    // board, task and member routes are all mounted at /api/boards, and each
    // router registers this middleware. Express runs every matching router's
    // middleware until one handles the route, so a task request would
    // authenticate twice and a member request three times — one redundant
    // users.findOne per extra router. Already-authenticated requests skip it.
    if (req.user) return next();

    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

module.exports = authenticate;
