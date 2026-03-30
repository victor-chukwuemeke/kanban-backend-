function validate(schema) {
  return (req, res, next) => {
    const errors = [];

    for (const [field, rules] of Object.entries(schema)) {
      const value = req.body[field];

      if (rules.required && (value === undefined || value === null || value === "")) {
        errors.push(`${field} is required`);
        continue;
      }

      if (value === undefined || value === null) continue;

      if (rules.type === "string" && typeof value !== "string") {
        errors.push(`${field} must be a string`);
        continue;
      }

      if (rules.type === "array" && !Array.isArray(value)) {
        errors.push(`${field} must be an array`);
        continue;
      }

      if (rules.minlength && typeof value === "string" && value.length < rules.minlength) {
        errors.push(`${field} must be at least ${rules.minlength} characters`);
      }

      if (rules.email && typeof value === "string") {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(value)) {
          errors.push(`${field} must be a valid email`);
        }
      }

      if (rules.enum && !rules.enum.includes(value)) {
        errors.push(`${field} must be one of: ${rules.enum.join(", ")}`);
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join(". ") });
    }

    next();
  };
}

module.exports = validate;
