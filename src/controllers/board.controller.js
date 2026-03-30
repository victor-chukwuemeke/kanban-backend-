const Board = require("../models/Board");

exports.getBoards = async (req, res) => {
  try {
    const boards = await Board.find({
      $or: [
        { userId: req.user._id },
        { "members.userId": req.user._id },
      ],
    });

    res.json({ message: "Boards retrieved successfully", boards });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

exports.getBoard = async (req, res) => {
  res.json({ message: "Board retrieved successfully", board: req.board });
};

exports.createBoard = async (req, res) => {
  try {
    const { name, columns } = req.body;

    const cols = (Array.isArray(columns) ? columns : []).map((colName) => ({
      name: colName,
      tasks: [],
    }));

    const board = await Board.create({
      name,
      userId: req.user._id,
      members: [
        {
          userId: req.user._id,
          email: req.user.email,
          username: req.user.username,
          role: "owner",
          avatar: req.user.avatar,
        },
      ],
      columns: cols,
    });

    res.status(201).json({ message: "Board created successfully", board });
  } catch (error) {
    console.error("Create board error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

exports.updateBoard = async (req, res) => {
  try {
    const board = req.board;
    const { name, columns } = req.body;

    if (name) board.name = name;

    if (columns) {
      const colNames = Array.isArray(columns) ? columns : [];
      const existingCols = new Map();
      board.columns.forEach((col) => {
        existingCols.set(col.name, col);
      });

      board.columns = colNames.map((colName) => {
        const existing = existingCols.get(colName);
        if (existing) {
          return existing;
        }
        return { name: colName, tasks: [] };
      });
    }

    await board.save();
    res.json({ message: "Board updated successfully", board });
  } catch (error) {
    console.error("Update board error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

exports.deleteBoard = async (req, res) => {
  try {
    await Board.findByIdAndDelete(req.board._id);
    res.json({ message: "Board deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};
