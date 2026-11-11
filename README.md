# tribunal

[![ci](https://github.com/forrestblade/tribunal/actions/workflows/ci.yml/badge.svg)](https://github.com/forrestblade/tribunal/actions/workflows/ci.yml)

A Discord bot that lets a small server moderate itself by vote. Anyone who has been around long enough can put a punishment to a vote; the server decides; the bot carries it out, logs it, and undoes it when the time is up. There are no moderators in the loop. The design assumes a tight-knit server of a few dozen people where the main problems are friction between regulars and the occasional outsider, and voice chat is where most of it happens.

Built for one server at a time. TypeScript, discord.js 14, SQLite through `node:sqlite`, no other runtime dependencies.

## How it works

**Filing.** A member files a case with `/case`, by right-clicking a person or a message ("Apps > File a case"), or by tagging the bot and the person (`@tribunal @them what they did`). A case names a punishment, optionally a rule, and a reason. Filing from a message copies the message as evidence, so deleting it later changes nothing.

**Voting.** The bot posts a card in the court channel with Yes and No buttons. The tally is hidden while the vote runs; only the turnout shows. When the case closes, the result and every voter's name are public, and a line goes to the log channel. A case closes at its deadline, or earlier once the outcome can't change. Voters can change their vote until then.

**Who votes.** Members who had been in the server 14+ days when the case was filed and aren't timed out. Not the accused, not the person who filed (their filing is their vote), and not anyone who filed against, or was filed against by, the accused in the last 7 days. The voter list is fixed when the case is filed.

**Who can be tried.** Anyone the bot can act on. The owner, administrators and anyone whose top role is above the bot's are out of reach by Discord's rules, so the bot refuses those cases up front.

**The ladder.** Punishments go up one step at a time. Each passed case records a strike at that step's level. A person can only be proposed for one level above their current one. The level drops one step for every 30 clean days after the last punishment ends, and strikes are forgotten 90 days after they end.

| Level | Punishment                          | Yes votes | Share                                 | Voting window |
| ----- | ----------------------------------- | --------- | ------------------------------------- | ------------- |
| –     | Cool-off: 10 min timeout, no strike | 3         | majority, closes as soon as it hits 3 | 3 min         |
| 1     | Warning by DM                       | 3         | majority                              | 30 min        |
| 2     | Timeout 1h                          | 4         | 2/3                                   | 15 min        |
| 3     | Timeout 24h                         | 5         | 2/3                                   | 2h            |
| 4     | Timeout 7 days                      | 6         | 2/3                                   | 24h           |
| 5     | Ban 30 days, lifted by the bot      | 8         | 3/4                                   | 48h           |
| 6     | Permanent ban                       | 10        | 3/4                                   | 72h           |

**Newcomers** (under 14 days) are on a shorter track: cool-off with 2 yes, kick with 3 yes (2/3, 15 min), ban with 4 yes (2/3, 1h).

**Voice.** The bot never joins voice and records nothing. It keeps 7 days of who was in which voice channel when. For a case about voice, the person filing must have shared a voice channel with the accused in the last 30 minutes, and some of the yes votes (2 up to level 3, 3 from level 4) must come from people who were there too. Timeouts also disconnect the person from voice.

**Feuds.** After A files against B, B can't file against A for 24 hours, but can post a statement on the case with the Statement button. Someone outside a feud can propose a 7 day **no-contact order** with `/nocontact`: the bot removes replies and mentions between the two and moves whoever joins the other's voice channel. 4 yes, 2/3, 2 hours.

**Appeals.** Any member can propose lifting a ban with `/appeal` once half of it has passed (30 days for a permanent ban). 5 yes, majority, 24 hours. If it passes the ban is lifted and the strike voided. A failed appeal can't be retried for 30 days. The banned person isn't in the server, so the bot DMs them the result and how appeals work before it bans them.

**Guardrails.** One open case per person per lane (cool-offs run alongside regular cases). After a failed vote the same punishment can't be proposed against the same person for 24 hours (30 minutes for cool-offs). More than 5 cases in an hour pauses filing for an hour. A case that couldn't pass with the voters available is refused with the reason. Every action carries the case number in Discord's audit log.

**Trial run.** With `"shadow": true` in the config everything works, strikes and ladders included, but nothing is applied to anyone. Run that for a couple of weeks, read the log, adjust the numbers, then set it to `false`.

## Commands

|                                                       |                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `/case who punishment reason [rule] [voice]`          | File a case                                                                              |
| Right-click a user > Apps > File a case               | Same, with a form                                                                        |
| Right-click a message > Apps > File a case about this | Same, and the message is attached as evidence                                            |
| `@tribunal @them what they did`                       | Same, the bot replies with a button that opens the form; reply to a message to attach it |
| `/nocontact first second reason`                      | Propose a no-contact order                                                               |
| `/appeal who reason`                                  | Propose lifting a ban                                                                    |
| `/record [who]`                                       | Someone's level, strikes and what can currently be proposed                              |
| `/status`                                             | Open cases, whether filing is paused, trial run or live                                  |
| `/help`                                               | The rules above, generated from the live policy                                          |

## Setup

### 1. Create the bot in Discord

1. Go to the [Developer Portal](https://discord.com/developers/applications), **New Application**, name it.
2. **Bot** tab: **Reset Token**, copy it. Turn off **Public Bot**. Under **Privileged Gateway Intents** turn on **Server Members Intent**. Leave Presence and Message Content off; the bot doesn't need them.
3. **General Information**: copy the **Application ID**.
4. In Discord, turn on Developer Mode (Settings > Advanced), then right-click the server, the court channel and the log channel and **Copy ID** for each. The court channel is where cards are posted and everyone votes; the log channel gets results. They can be the same channel.

### 2. Configure

```sh
git clone https://github.com/forrestblade/tribunal.git && cd tribunal
npm ci
cp config.example.json config.json   # fill in the ids and your rules; leave "shadow": true
export DISCORD_TOKEN=...             # or put "token" in config.json
npm run build
npm run invite                       # prints the invite link
```

Open the link and add the bot to the server. It asks for exactly: View Channels, Send Messages, Embed Links, Read Message History, Manage Messages, Timeout Members, Kick Members, Ban Members, Move Members. Never give it Administrator.

Then in **Server Settings > Roles**, drag the bot's role **above** every role it should be able to act on. People above it are immune, and `/record` says so.

```sh
npm run register                     # registers the slash commands on your server
npm start
```

Run `npm run register` again whenever you change the steps or the rules in `config.json`.

### 3. Run it somewhere

`deploy/gcp.md` walks through a free-tier Google Cloud VM with a systemd service, hardening, and nightly SQLite snapshots. `deploy/install.sh` does the install and updates.

## Configuration

`config.json`:

| Key                                                          | What                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `applicationId`, `guildId`, `courtChannelId`, `logChannelId` | Ids from the setup above                                                   |
| `token`                                                      | Bot token, if not using the `DISCORD_TOKEN` environment variable           |
| `shadow`                                                     | `true` for a trial run, `false` to act. Default `true`                     |
| `rules`                                                      | Short rule names shown as a menu when filing, up to 25                     |
| `databasePath`                                               | Default `data/tribunal.db`                                                 |
| `policy`                                                     | Any subset of the policy in `src/policy.ts`, deep-merged over the defaults |

Everything in the ladder is configurable. Example, a gentler server:

```json
"policy": {
  "memberMinDays": 7,
  "breaker": { "maxCasesPerHour": 3, "pauseMinutes": 120 },
  "memberSteps": [
    { "id": "cooloff", "label": "Cool-off 10 min", "level": null, "punishment": { "type": "cooloff", "minutes": 10 }, "yes": 3, "share": "majority", "windowMinutes": 3, "witnessYes": 2, "closeOnThreshold": true, "retryAfterFailMinutes": 30 },
    { "id": "warn", "label": "Warning", "level": 1, "punishment": { "type": "warn" }, "yes": 3, "share": "majority", "windowMinutes": 60, "witnessYes": 2, "closeOnThreshold": false, "retryAfterFailMinutes": 1440 },
    { "id": "timeout-24h", "label": "Timeout 24h", "level": 2, "punishment": { "type": "timeout", "minutes": 1440 }, "yes": 5, "share": "two-thirds", "windowMinutes": 240, "witnessYes": 2, "closeOnThreshold": false, "retryAfterFailMinutes": 1440 }
  ]
}
```

Step ids are stable names used in commands and the database; keep them when you change numbers. Timeouts cap at 28 days (Discord's limit). A `ban` with `"days": null` is permanent.

## Development

```sh
npm ci
npm run check       # typecheck, lint (eslint + prettier), tests
npm test            # 95 tests: rules engine, store, rendering, Discord actions, no-contact guard, the bot through fake Discord objects
npm run build
```

Layout:

- `src/policy.ts` the defaults and the share math
- `src/engine/` pure rules, no Discord: `tally.ts` (when a vote is decided), `ladder.ts` (levels and decay), `witness.ts` (who was in voice), `engine.ts` (filing guards, voting, settling; every check and write in one SQLite transaction)
- `src/store.ts` SQLite schema and queries on `node:sqlite`
- `src/discord/` the adapter
  - `bot.ts` the client, event wiring and the clock
  - `interactions.ts` routes commands, buttons, modals and autocomplete to the engine
  - `court.ts` posts, refreshes and closes vote cards; writes the log channel; runs deadlines and due unbans
  - `actions.ts` the only file that times out, kicks, bans or DMs anyone
  - `no-contact.ts` enforces no-contact orders from mention and voice events
  - `mentions.ts` the `@bot @them ...` entry point
  - `forms.ts`, `custom-ids.ts`, `render.ts`, `commands.ts`, `members.ts`, `drafts.ts`
- `src/format.ts`, `logger.ts`, `ttl-map.ts` small shared pieces
- `src/index.ts`, `register.ts`, `invite.ts`, `backup.ts` entrypoints

## Design notes

Why it looks like this, briefly. More in `DESIGN.md`.

- **Hidden tally.** Seeing a running count changes votes: in a randomized experiment a single early upvote made later positive votes 32% more likely (Muchnik, Aral and Taylor, _Science_ 2013). The count is hidden until the case closes.
- **Public names afterwards.** In a small group, secret votes breed suspicion about who voted which way. Names being public after the fact is accountability without letting early votes steer later ones.
- **The proposer doesn't vote and can't be voted against in return for a day.** Lobsters requires a reason on every flag "to curb punishing disagreement"; Wikipedia community bans are decided by editors "not involved in the underlying dispute." Both ideas are in here.
- **Steps, not jumps.** League of Legends' Tribunal reported that 74% of players warned once never came back. Mild first punishments do most of the work, so the ladder forces them.
- **Voice needs witnesses.** Interviews with Discord moderators found voice moderation ran on "hearsay and first impressions" and produced false accusations (Jiang et al., CSCW 2019). The bot can't record voice and shouldn't, so it requires the people who were there to agree.
- **No-contact orders.** Most regular-on-regular trouble is two people who can't leave each other alone. Wikipedia's interaction ban, including the no-fault two-way kind, is the model.
- **Cooldowns and a brake.** Straight from game vote-kick systems: TF2 waits five minutes after a failed vote; CS2 escalates cooldowns for people who keep calling votes.
- **Trial run first.** Thresholds for a 30 person server are guesses until you've watched real cases.

## Limits

- One server per bot process. Run two processes with two configs for two servers.
- Discord's Server Members intent is required (it's a switch in the Developer Portal; review only kicks in above 10,000 users).
- The bot can't DM people who have DMs closed; it notes that on the card and in the log.
- Statements are plain text on the card, not threads.
- `node:sqlite` is marked experimental by Node, so the start script silences that one warning. The API has been stable since Node 22.13.

MIT.
