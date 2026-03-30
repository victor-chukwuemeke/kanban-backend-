const router = require("express").Router();
const boardController = require("../controllers/board.controller");
const authenticate = require("../middleware/auth");
const requireRole = require("../middleware/role");
const validate = require("../middleware/validate");

router.use(authenticate);

router.get("/", boardController.getBoards);

router.post(
  "/",
  validate({
    name: { required: true, type: "string" },
  }),
  boardController.createBoard
);

router.get("/:boardId", requireRole("viewer"), boardController.getBoard);
router.put("/:boardId", requireRole("owner"), boardController.updateBoard);
router.delete("/:boardId", requireRole("owner"), boardController.deleteBoard);

module.exports = router;
