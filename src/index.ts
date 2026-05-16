import "dotenv/config";
import { startCleanupScheduler } from "./cleanup.js";
import { createServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const { app, db } = createServer();

startCleanupScheduler(db);

app.listen(PORT, () => {
  console.log(`[server] Clip pipeline running on http://localhost:${PORT}`);
  if (process.env.NODE_ENV !== "production") {
    console.log(
      '[server] Frontend: run "bun run dev:client" to build the React app',
    );
  }
});
