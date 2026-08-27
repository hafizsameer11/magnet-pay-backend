import { createApp } from "./app.js";
import { env } from "./lib/prisma.js";

const port = Number(env("PORT", "4000"));
const host = env("HOST", "0.0.0.0");
const app = createApp();

app.listen(port, host, () => {
  console.log(`MagnetPay API listening on http://${host}:${port}`);
});
