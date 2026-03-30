const router = require("express").Router();
const authController = require("../controllers/auth.controller");
const authenticate = require("../middleware/auth");
const upload = require("../middleware/upload");
const validate = require("../middleware/validate");

router.post(
  "/signup",
  validate({
    username: { required: true, type: "string", minlength: 2 },
    email: { required: true, type: "string", email: true },
    password: { required: true, type: "string", minlength: 6 },
  }),
  authController.signup
);

router.post(
  "/login",
  validate({
    email: { required: true, type: "string", email: true },
    password: { required: true, type: "string" },
  }),
  authController.login
);

router.post("/logout", authenticate, authController.logout);
router.get("/me", authenticate, authController.getMe);
router.put("/me", authenticate, authController.updateMe);
router.put("/me/avatar", authenticate, upload.single("avatar"), authController.updateAvatar);

module.exports = router;
