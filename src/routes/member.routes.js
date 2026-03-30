const router = require("express").Router();
const memberController = require("../controllers/member.controller");
const authenticate = require("../middleware/auth");
const requireRole = require("../middleware/role");
const validate = require("../middleware/validate");

router.use(authenticate);

router.post(
  "/:boardId/members",
  requireRole("owner"),
  validate({
    email: { required: true, type: "string", email: true },
    role: { required: true, type: "string", enum: ["editor", "viewer"] },
  }),
  memberController.inviteMember
);

router.put(
  "/:boardId/members/:memberId",
  requireRole("owner"),
  validate({
    role: { required: true, type: "string", enum: ["editor", "viewer"] },
  }),
  memberController.changeMemberRole
);

router.delete(
  "/:boardId/members/:memberId",
  requireRole("owner"),
  memberController.removeMember
);

router.post(
  "/:boardId/leave",
  requireRole("viewer"),
  memberController.leaveBoard
);

module.exports = router;
