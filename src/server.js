require("dotenv").config();

const app = require("./app");
const connectDB = require("./config/db");

const PORT = process.env.PORT || 6000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

    // Keep-alive: ping own health endpoint every 14 minutes to prevent Render free tier sleep
    const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL
      ? `${process.env.RENDER_EXTERNAL_URL}/api/health`
      : null;

    if (KEEP_ALIVE_URL) {
      setInterval(() => {
        fetch(KEEP_ALIVE_URL).catch(() => {});
      }, 14 * 60 * 1000);
      console.log(`Keep-alive pinging ${KEEP_ALIVE_URL} every 14m`);
    }
  });
});
