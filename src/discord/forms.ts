// The two modals: filing a case and posting a statement. Built here, read here.
import {
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from "discord.js";
import type { Step } from "../policy.js";
import { OTHER_RULE, REASON_MAX } from "./commands.js";
import { encodeCustomId, type MessageRef } from "./custom-ids.js";

const FIELDS = { punishment: "punishment", rule: "rule", where: "where", reason: "reason", statement: "text" } as const;
const WHERE = { voice: "voice", text: "text" } as const;
const TITLE_MAX = 45;
export const STATEMENT_MAX = 900;

export interface FileFormInput {
  targetId: string;
  targetName: string;
  targetInVoice: boolean;
  steps: Step[];
  rules: string[];
  evidence: MessageRef | null;
  draftReason: string;
}

export function fileForm(input: FileFormInput): ModalBuilder {
  const option = (label: string, value: string, isDefault = false) =>
    new StringSelectMenuOptionBuilder().setLabel(label).setValue(value).setDefault(isDefault);
  return new ModalBuilder()
    .setCustomId(encodeCustomId({ kind: "file", targetId: input.targetId, evidence: input.evidence }))
    .setTitle(`Case against ${input.targetName}`.slice(0, TITLE_MAX))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Punishment")
        .setDescription("Only the steps allowed for them right now are listed.")
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId(FIELDS.punishment)
            .setRequired(true)
            .addOptions(input.steps.map((s) => option(s.label, s.id))),
        ),
      new LabelBuilder().setLabel("Rule").setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId(FIELDS.rule)
          .setRequired(false)
          .addOptions([...input.rules.slice(0, 24), OTHER_RULE].map((r) => option(r, r))),
      ),
      new LabelBuilder()
        .setLabel("Where did it happen?")
        .setDescription("Voice cases need yes votes from people who were in the channel.")
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId(FIELDS.where)
            .setRequired(true)
            .addOptions(
              option("In voice chat", WHERE.voice, input.targetInVoice),
              option("In text", WHERE.text, !input.targetInVoice),
            ),
        ),
      new LabelBuilder()
        .setLabel("What happened")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(FIELDS.reason)
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(REASON_MAX)
            .setRequired(true)
            .setValue(input.draftReason.slice(0, REASON_MAX)),
        ),
    );
}

export interface FileFormValues {
  stepId: string;
  rule: string | null;
  voice: boolean;
  reason: string;
}

export function readFileForm(i: ModalSubmitInteraction): FileFormValues {
  return {
    stepId: i.fields.getStringSelectValues(FIELDS.punishment)[0] ?? "",
    rule: optionalSelect(i, FIELDS.rule),
    voice: i.fields.getStringSelectValues(FIELDS.where)[0] === WHERE.voice,
    reason: i.fields.getTextInputValue(FIELDS.reason).trim(),
  };
}

export function statementForm(caseId: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(encodeCustomId({ kind: "statement", caseId }))
    .setTitle(`Statement on case #${caseId}`)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Your side")
        .setDescription("Shown on the case card to everyone voting.")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(FIELDS.statement)
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(STATEMENT_MAX)
            .setRequired(true),
        ),
    );
}

export function readStatementForm(i: ModalSubmitInteraction): string {
  return i.fields.getTextInputValue(FIELDS.statement).trim();
}

/** A select menu that was not required comes back absent, not empty. */
function optionalSelect(i: ModalSubmitInteraction, id: string): string | null {
  try {
    return i.fields.getStringSelectValues(id)[0] ?? null;
  } catch {
    return null;
  }
}
