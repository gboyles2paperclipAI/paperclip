import { runStartupModuleValidationOrExit } from "./startup-module-validation.js";

export type { StartedServer } from "./main.js";

await runStartupModuleValidationOrExit({
  exit: process.exit,
});

const serverModule = await import("./main.js");

if (serverModule.isMainModule(import.meta.url)) {
  void serverModule.startServer().catch((err) => {
    serverModule.logger.error({ err }, "Paperclip server failed to start");
    process.exit(1);
  });
}
