const router = require("express").Router();
const taskController = require("../controllers/task.controller");
const authenticate = require("../middleware/auth");
const requireRole = require("../middleware/role");
const validate = require("../middleware/validate");

router.use(authenticate);

router.post(
  "/:boardId/tasks",
  requireRole("editor"),
  validate({
    title: { required: true, type: "string" },
    status: { required: true, type: "string" },
  }),
  taskController.createTask
);

router.put("/:boardId/tasks/:taskId", requireRole("editor"), taskController.updateTask);
router.delete("/:boardId/tasks/:taskId", requireRole("editor"), taskController.deleteTask);

router.patch(
  "/:boardId/tasks/:taskId/status",
  requireRole("editor"),
  validate({
    oldStatus: { required: true, type: "string" },
    newStatus: { required: true, type: "string" },
  }),
  taskController.changeStatus
);

router.patch(
  "/:boardId/tasks/:taskId/subtasks/:subtaskId",
  requireRole("editor"),
  taskController.toggleSubtask
);

router.patch(
  "/:boardId/tasks/:taskId/assignees",
  requireRole("editor"),
  validate({
    assignees: { required: true, type: "array" },
  }),
  taskController.updateAssignees
);

module.exports = router;
