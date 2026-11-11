# Design

The brief: a bot for a tight-knit Discord of about 30 people, 15 or so active daily, where the trouble is friction between regulars and sometimes an outsider, voice chat is the main room, and there are no moderators. Members tag the bot, vote, and the bot carries out the result. Bans are allowed. Voter names are public.

## The pipeline

Most protection against abuse is in the first two stages, before anyone votes.

1. **File.** Slash command, right-click, or mention. Must name a punishment and a reason; a rule is optional. Evidence is copied at filing time.
2. **Check.** The engine refuses anything that can't be right: the wrong track, skipping ladder steps, a case already open in that lane, a retaliation within 24 hours, a retry too soon after a failure, a voice case from someone who wasn't there, a voter list too small to ever pass, or the hourly brake. Each refusal says why and when it will be allowed.
3. **Vote.** Electorate frozen at filing. Hidden tally. Early close only when the outcome is certain; cool-offs close on the threshold because speed is the point.
4. **Act.** DM first (a banned person can't be DMed after), then apply. Timeouts for people who left are stored and applied on return. Bans schedule their own lifting. Failures to act are notes on the card and log, never silent.
5. **Review.** Appeals by any member once half the ban has passed. `/record` for anyone's strikes. Everything in the log channel and the Discord audit log.

## Choices and the reasons

**No random jury.** For a 30 person server, a jury of 5 is a third of the active members anyway, and juror no-shows would stall cases. Open voting with a high bar and public names is more legitimate at this size. If pile-ons appear, a jury is the next tool: 2 seconders, then 5 to 7 random eligible voters. The engine's electorate step is where it would go.

**The proposer's vote doesn't count.** "4 yes" means four other people. It takes the sting out of feud-filing and makes the thresholds mean what they say.

**Involvement exclusion is time-bounded, not topic-bounded.** We can't tell who is "in the argument" without reading messages, which we deliberately don't. Instead: anyone who filed against or was filed against by the accused in the last 7 days sits out. Simple and explainable.

**Membership is first-sighting, not current join.** Discord's `joinedAt` resets when someone leaves and rejoins. The store remembers the earliest time it ever saw someone, so leaving and coming back doesn't demote a regular to the newcomer track, and doesn't let someone dodge the newcomer track either.

**Decay runs from when the punishment ends.** A 30 day ban doesn't decay while it's being served. Someone back from a ban is still at level 5, so a permanent ban is the next step if they keep it up, and a clean month after that drops them to 4.

**Timeout instead of server mute for cool-offs.** A server mute persists until someone unmutes, works only while they're in voice, and needs a second pass to lift. A 10 minute timeout plus a disconnect expires on its own.

**Voice evidence is presence, not audio.** The bot tracks voice state changes (no privileged intent, no audio) and keeps 7 days. Witnesses are people whose sessions overlapped the accused's in the same channel in the last 30 minutes. For a voice case the filer must be a witness and 2 or 3 of the yes votes must be witnesses.

**No-contact orders are mechanical.** Replies and mentions between the two are removed; whoever joins the other's voice channel is moved out. Both come from events that carry no message text. It's a two-way, no-fault order so proposing one doesn't require deciding who started it.

**Shadow mode is real except for the last step.** Cases, votes, strikes, ladders, appeals and no-contact orders all run and are stored separately from live data. The accused is still DMed what would have happened. That makes the trial run a real rehearsal, not a demo.

**The breaker is dumb on purpose.** Count cases in the last hour; past 5, pause for an hour and say so. It catches both a bad night and a bug.

## What the engine guarantees

- Every check-and-write is one SQLite transaction with `BEGIN IMMEDIATE`, so two clicks at the same instant can't both close a case, and two filings can't both pass the "one open case" check.
- `closeCase` and `finishScheduled` and `takePending` are compare-and-set; the Discord side acts only after one of them says it won.
- Scheduled unbans and owed timeouts live in the database and survive restarts. On startup the bot re-posts any card it crashed before posting.
- The engine never touches Discord. It returns effects; `actions.ts` applies them. That's what makes it testable, and what makes the trial run a one-line switch.

## Places to go next

- A jury mode for larger servers.
- A vote budget per member per week, so joining pile-ons costs something.
- A bridging rule: yes votes must include people who don't usually vote together. Needs a few months of voting history.
- Threads per case instead of statements on the card.
- A weekly digest to the log channel.
- A `/propose` command to change the policy by server-wide vote with a high bar, so the rules themselves are community-run.

## Sources

- Muchnik, Aral, Taylor. Social Influence Bias: A Randomized Experiment. _Science_ 341 (2013).
- Fan, Zhang. Digital Juries: A Civics-Oriented Approach to Platform Governance. _CHI_ 2020.
- Jiang, Kiene, Middler, Brubaker, Fiesler. Moderation Challenges in Voice-based Online Communities on Discord. _CSCW_ 2019.
- Xiao, Cheshire, Salehi. Addressing Interpersonal Harm in Online Gaming Communities: The Opportunities and Challenges for a Restorative Justice Approach. _ACM TOCHI_ 2023.
- Zhang, Hugh, Bernstein. PolicyKit: Building Governance in Online Communities. _UIST_ 2020.
- Riot Games Tribunal metrics (2011, 2012), as recorded on the League of Legends wiki.
- Lobsters "About" page on invitation trees and flag reasons; Wikipedia banning policy on uninvolved editors and interaction bans; TF2 and CS2 vote-kick cooldowns.
