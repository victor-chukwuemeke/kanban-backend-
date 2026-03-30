const Board = require("../models/Board");

const HIERARCHY = ["viewer", "editor", "owner"];

function requireRole(minRole) {
  return async (req, res, next) => {
    try {
      const board = await Board.findById(req.params.boardId);
      if (!board) {
        return res.status(404).json({ error: "Board not found" });
      }

      let role = null;
      if (board.userId.toString() === req.user.id) {
        role = "owner";
      } else {
        const member = board.members.find(
          (m) => m.userId.toString() === req.user.id
        );
        if (member) role = member.role;
      }

      if (!role || HIERARCHY.indexOf(role) < HIERARCHY.indexOf(minRole)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      req.board = board;
      req.userRole = role;
      next();
    } catch (error) {
      console.error("Role middleware error:", error);
      return res.status(500).json({ error: "Server error" });
    }
  };
}

module.exports = requireRole;
