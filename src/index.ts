import { loadConfig, type Config } from "./config.js";
import { Bot } from "./discord/bot.js";
import { Engine } from "./engine/engine.js";
import { errorMessage, logger } from "./logger.js";
import { Store } from "./store.js";

let config: Config;
try {
  config = loadConfig();
} catch (e) {
  logger.error(errorMessage(e));
  process.exit(1);
}

const store = new Store(config.databasePath);
const engine = new Engine(store, config.policy, config.shadow);
const bot = new Bot(config, store, engine);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info(`${signal}: shutting down`);
    void bot.stop().finally(() => {
      store.close();
      process.exit(0);
    });
  });
}

bot.start().catch((e) => {
  logger.error("could not start", e);
  process.exit(1);
});
