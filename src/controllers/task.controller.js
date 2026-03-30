exports.createTask = async (req, res) => {
  try {
    const board = req.board;
    const { title, description, status, tag, assignees, subtasks } = req.body;

    const column = board.columns.find((col) => col.name === status);
    if (!column) {
      return res.status(400).json({ error: `Column "${status}" not found` });
    }

    // Validate assignees
    let validAssignees = [];
    if (assignees && assignees.length > 0) {
      const memberIds = board.members
        .filter((m) => m.role !== "viewer")
        .map((m) => m.userId.toString());

      validAssignees = [...new Set(assignees)].filter((id) =>
        memberIds.includes(id)
      );
    }

    const task = {
      title,
      description: description || "",
      status,
      tag: tag || null,
      assignees: validAssignees,
      subtasks: (subtasks || []).map((s) =>
        typeof s === "string" ? { title: s, isCompleted: false } : s
      ),
    };

    column.tasks.push(task);
    await board.save();

    const createdTask = column.tasks[column.tasks.length - 1];
    res.status(201).json({ message: "Task created successfully", task: createdTask });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

exports.updateTask = async (req, res) => {
  try {
    const board = req.board;
    const { taskId } = req.params;
    const { title, description, status, previousStatus, tag, assignees, subtasks } = req.body;

    // Find the task in its current column
    let task = null;
    let sourceColumn = null;

    for (const col of board.columns) {
      const found = col.tasks.id(taskId);
      if (found) {
        task = found;
        sourceColumn = col;
        break;
      }
    }

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    // Update fields
    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (tag !== undefined) task.tag = tag;

    // Validate and update assignees
    if (assignees !== undefined) {
      const memberIds = board.members
        .filter((m) => m.role !== "viewer")
        .map((m) => m.userId.toString());
      task.assignees = [...new Set(assignees)].filter((id) =>
        memberIds.includes(id)
      );
    }

    // Update subtasks
    if (subtasks !== undefined) {
      task.subtasks = subtasks.map((s) => ({
        _id: s.id || undefined,
        title: s.title,
        isCompleted: s.isCompleted || false,
      }));
    }

    // Move between columns if status changed
    if (status && previousStatus && status !== previousStatus) {
      const destColumn = board.columns.find((col) => col.name === status);
      if (!destColumn) {
        return res.status(400).json({ error: `Column "${status}" not found` });
      }

      task.status = status;

      // Remove from source, add to destination
      sourceColumn.tasks.pull(taskId);
      destColumn.tasks.push(task);
    } else if (status) {
      task.status = status;
    }

    await board.save();
    res.json({ message: "Task updated successfully", task });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

exports.deleteTask = async (req, res) => {
  try {
    const board = req.board;
    const { taskId } = req.params;

    let found = false;
    for (const col of board.columns) {
      const task = col.tasks.id(taskId);
      if (task) {
        col.tasks.pull(taskId);
        found = true;
        break;
      }
    }

    if (!found) {
      return res.status(404).json({ error: "Task not found" });
    }

    await board.save();
    res.json({ message: "Task deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

exports.changeStatus = async (req, res) => {
  try {
    const board = req.board;
    const { taskId } = req.params;
    const { oldStatus, newStatus } = req.body;

    const sourceColumn = board.columns.find((col) => col.name === oldStatus);
    const destColumn = board.columns.find((col) => col.name === newStatus);

    if (!sourceColumn) {
      return res.status(400).json({ error: `Column "${oldStatus}" not found` });
    }
    if (!destColumn) {
      return res.status(400).json({ error: `Column "${newStatus}" not found` });
    }

    const task = sourceColumn.tasks.id(taskId);
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    task.status = newStatus;
    sourceColumn.tasks.pull(taskId);
    destColumn.tasks.push(task);

    await board.save();
    res.json({ message: "Task status changed successfully", task });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

exports.toggleSubtask = async (req, res) => {
  try {
    const board = req.board;
    const { taskId, subtaskId } = req.params;

    let subtask = null;
    for (const col of board.columns) {
      const task = col.tasks.id(taskId);
      if (task) {
        subtask = task.subtasks.id(subtaskId);
        break;
      }
    }

    if (!subtask) {
      return res.status(404).json({ error: "Subtask not found" });
    }

    subtask.isCompleted = !subtask.isCompleted;
    await board.save();
    res.json({ message: "Subtask toggled successfully", subtask });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

exports.updateAssignees = async (req, res) => {
  try {
    const board = req.board;
    const { taskId } = req.params;
    const { assignees } = req.body;

    let task = null;
    for (const col of board.columns) {
      const found = col.tasks.id(taskId);
      if (found) {
        task = found;
        break;
      }
    }

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    const memberIds = board.members
      .filter((m) => m.role !== "viewer")
      .map((m) => m.userId.toString());
    task.assignees = [...new Set(assignees)].filter((id) =>
      memberIds.includes(id)
    );

    await board.save();
    res.json({ message: "Assignees updated successfully", task });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};
