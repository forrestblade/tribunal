import { loadConfig } from "./config.js";
import { Bot } from "./discord/bot.js";
import { Engine } from "./engine/engine.js";
import { Store } from "./store.js";

const config = loadConfig();
const store = new Store(config.databasePath);
const engine = new Engine(store, config.policy, config.shadow);
const bot = new Bot(config, store, engine);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`${signal}: shutting down`);
    void bot.stop().finally(() => {
      store.close();
      process.exit(0);
    });
  });
}

bot.start().catch((e) => {
  console.error("could not start", e);
  process.exit(1);
});
