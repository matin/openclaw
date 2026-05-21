import { splitShellArgs } from "../utils/shell-argv.js";
import { buildCommandPayloadCandidates } from "./command-analysis/risks.js";
import { explainShellCommand } from "./command-explainer/extract.js";
import type { CommandContext } from "./command-explainer/types.js";

export type ControlShellPolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "requires-approval"; warning: string };

export type ControlShellParsedSegment = {
  argv: string[];
  raw?: string;
};

type ControlShellCandidateContext = CommandContext | "parsed-segment" | "fallback";

type ControlShellCandidate = {
  argv: string[];
  raw: string;
  context: ControlShellCandidateContext;
};

const APPROVAL_COMMAND_DENY_MESSAGE = [
  "exec cannot run /approve commands.",
  "Show the /approve command to the user as chat text, or route it through the approval command handler instead of shell execution.",
].join(" ");

const INTERACTIVE_CHANNEL_LOGIN_DENY_MESSAGE = [
  "exec cannot run interactive OpenClaw channel login commands.",
  "Run `openclaw channels login` in a terminal on the gateway host, or use the channel-specific login agent tool when available (for WhatsApp: `whatsapp_login`).",
].join(" ");

const SECURITY_AUDIT_SUPPRESSION_WARNING =
  "Warning: security audit suppression changes require explicit approval unless exec is running in yolo mode.";

const APPROVAL_COMMAND_PATTERN =
  /(?:^|[\s'"`;&|()])\/approve(?:@[^\s'"`;&|()]+)?\s+[A-Za-z0-9][A-Za-z0-9._:-]*\s+(?:allow-once|allow-always|always|deny)\b/iu;

const OPENCLAW_GLOBAL_FLAGS_WITH_VALUES = new Set(["--container", "--log-level", "--profile"]);

const OPENCLAW_GLOBAL_FLAGS_WITHOUT_VALUES = new Set(["--dev", "--no-color"]);

const READ_ONLY_CONFIG_SUBCOMMANDS = new Set(["get", "schema", "validate"]);
const MUTATING_CONFIG_SUBCOMMANDS = new Set(["set", "unset", "patch", "apply"]);

function normalizeCommandBaseName(token: string | undefined): string {
  if (!token) {
    return "";
  }
  const base = token.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  return base.replace(/\.(?:cmd|exe)$/u, "");
}

function stripOpenClawPackageRunner(argv: string[]): string[] {
  const commandName = normalizeCommandBaseName(argv[0]);
  if (commandName === "openclaw") {
    return argv;
  }
  if (
    (commandName === "pnpm" || commandName === "npm" || commandName === "yarn") &&
    normalizeCommandBaseName(argv[1]) === "openclaw"
  ) {
    return argv.slice(1);
  }
  if (
    (commandName === "pnpm" || commandName === "npm" || commandName === "yarn") &&
    (argv[1] === "exec" || argv[1] === "dlx" || argv[1] === "run") &&
    normalizeCommandBaseName(argv[2]) === "openclaw"
  ) {
    return argv.slice(2);
  }
  if (commandName === "bun" && normalizeCommandBaseName(argv[1]) === "openclaw") {
    return argv.slice(1);
  }
  if (commandName === "npx" || commandName === "bunx") {
    let index = 1;
    while (index < argv.length) {
      const token = argv[index] ?? "";
      if (token === "--") {
        index += 1;
        break;
      }
      if (!token.startsWith("-") || token === "-") {
        break;
      }
      index += 1;
      if ((token === "-p" || token === "--package") && index < argv.length) {
        index += 1;
      }
    }
    if (normalizeCommandBaseName(argv[index]) === "openclaw") {
      return argv.slice(index);
    }
  }
  return argv;
}

function stripOpenClawGlobalOptions(argv: string[]): string[] | null {
  const openclawArgv = stripOpenClawPackageRunner(argv);
  if (normalizeCommandBaseName(openclawArgv[0]) !== "openclaw") {
    return null;
  }
  let index = 1;
  while (index < openclawArgv.length) {
    const arg = openclawArgv[index] ?? "";
    if (OPENCLAW_GLOBAL_FLAGS_WITHOUT_VALUES.has(arg)) {
      index += 1;
      continue;
    }
    if (OPENCLAW_GLOBAL_FLAGS_WITH_VALUES.has(arg)) {
      index += 2;
      continue;
    }
    if ([...OPENCLAW_GLOBAL_FLAGS_WITH_VALUES].some((flag) => arg.startsWith(`${flag}=`))) {
      index += 1;
      continue;
    }
    break;
  }
  return openclawArgv.slice(index);
}

export function parseOpenClawChannelsLoginShellCommand(raw: string): boolean {
  const argv = splitShellArgs(raw);
  return argv ? isInteractiveOpenClawChannelLoginArgv(argv) : false;
}

function isInteractiveOpenClawChannelLoginArgv(argv: string[]): boolean {
  const openclawArgs = stripOpenClawGlobalOptions(argv);
  return (
    openclawArgs !== null &&
    (openclawArgs[0] === "channels" || openclawArgs[0] === "channel") &&
    openclawArgs[1] === "login"
  );
}

function isReadOnlySecurityAuditSuppressionInspection(argv: string[]): boolean {
  const openclawArgs = stripOpenClawGlobalOptions(argv);
  return (
    openclawArgs !== null &&
    openclawArgs[0] === "config" &&
    READ_ONLY_CONFIG_SUBCOMMANDS.has(openclawArgs[1] ?? "")
  );
}

function isMutatingOpenClawConfigCommand(argv: string[]): boolean {
  const openclawArgs = stripOpenClawGlobalOptions(argv);
  return (
    openclawArgs !== null &&
    openclawArgs[0] === "config" &&
    MUTATING_CONFIG_SUBCOMMANDS.has(openclawArgs[1] ?? "")
  );
}

function textMentionsSecurityAuditSuppressions(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("security.audit.suppressions") ||
    /["']?security["']?[\s\S]{0,200}["']?audit["']?[\s\S]{0,200}["']?suppressions["']?/.test(
      normalized,
    )
  );
}

function candidateMentionsSecurityAuditSuppressions(candidate: ControlShellCandidate): boolean {
  return textMentionsSecurityAuditSuppressions(`${candidate.raw} ${candidate.argv.join(" ")}`);
}

function removeCandidateText(
  command: string,
  candidates: readonly ControlShellCandidate[],
): string {
  let remaining = command;
  for (const candidate of candidates) {
    const raw = candidate.raw.trim();
    if (raw.length === 0) {
      continue;
    }
    remaining = remaining.replace(raw, " ");
  }
  return remaining;
}

function requiresSecurityAuditSuppressionApproval(params: {
  command: string;
  candidates: readonly ControlShellCandidate[];
}): boolean {
  const mentioningCandidates = params.candidates.filter(candidateMentionsSecurityAuditSuppressions);
  if (mentioningCandidates.length > 0) {
    if (mentioningCandidates.some((candidate) => isMutatingOpenClawConfigCommand(candidate.argv))) {
      return true;
    }
    if (
      mentioningCandidates.every((candidate) =>
        isReadOnlySecurityAuditSuppressionInspection(candidate.argv),
      )
    ) {
      return textMentionsSecurityAuditSuppressions(
        removeCandidateText(params.command, mentioningCandidates),
      );
    }
    return true;
  }

  if (!textMentionsSecurityAuditSuppressions(params.command)) {
    return false;
  }
  return true;
}

function appendCandidate(
  candidates: ControlShellCandidate[],
  seen: Set<string>,
  candidate: ControlShellCandidate,
): void {
  const key = `${candidate.context}\0${candidate.raw}\0${candidate.argv.join("\0")}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  candidates.push(candidate);
}

function candidateFromRaw(
  raw: string,
  context: ControlShellCandidateContext,
): ControlShellCandidate {
  return {
    argv: splitShellArgs(raw) ?? [],
    raw,
    context,
  };
}

function appendPayloadCandidates(params: {
  candidates: ControlShellCandidate[];
  seen: Set<string>;
  argv: string[];
  context: ControlShellCandidateContext;
}): void {
  for (const payload of buildCommandPayloadCandidates(params.argv)) {
    appendCandidate(params.candidates, params.seen, candidateFromRaw(payload, params.context));
  }
}

async function buildControlShellCandidates(params: {
  command: string;
  parsedSegments?: readonly ControlShellParsedSegment[];
}): Promise<ControlShellCandidate[]> {
  const candidates: ControlShellCandidate[] = [];
  const seen = new Set<string>();

  for (const segment of params.parsedSegments ?? []) {
    appendCandidate(candidates, seen, {
      argv: segment.argv,
      raw: segment.raw ?? segment.argv.join(" "),
      context: "parsed-segment",
    });
    appendPayloadCandidates({
      candidates,
      seen,
      argv: segment.argv,
      context: "parsed-segment",
    });
  }

  try {
    const explanation = await explainShellCommand(params.command);
    if (explanation.ok) {
      for (const step of [...explanation.topLevelCommands, ...explanation.nestedCommands]) {
        appendCandidate(candidates, seen, {
          argv: step.argv,
          raw: step.text,
          context: step.context,
        });
        appendPayloadCandidates({
          candidates,
          seen,
          argv: step.argv,
          context: step.context,
        });
      }
      return candidates;
    }
  } catch {
    // Fall back to best-effort line parsing below.
  }

  for (const line of params.command.split(/\r?\n/u)) {
    const raw = line.trim();
    if (raw.length === 0) {
      continue;
    }
    const fallback = candidateFromRaw(raw, "fallback");
    appendCandidate(candidates, seen, fallback);
    appendPayloadCandidates({
      candidates,
      seen,
      argv: fallback.argv,
      context: "fallback",
    });
  }

  return candidates;
}

export async function inspectControlShellCommand(params: {
  command: string;
  parsedSegments?: readonly ControlShellParsedSegment[];
}): Promise<ControlShellPolicyDecision> {
  const command = params.command.trim();
  if (APPROVAL_COMMAND_PATTERN.test(command)) {
    return { kind: "deny", message: APPROVAL_COMMAND_DENY_MESSAGE };
  }

  const candidates = await buildControlShellCandidates({
    command,
    parsedSegments: params.parsedSegments,
  });

  if (
    candidates.some(
      (candidate) =>
        APPROVAL_COMMAND_PATTERN.test(candidate.raw) ||
        /^\/approve(?:@.+)?$/iu.test(candidate.argv[0] ?? ""),
    )
  ) {
    return { kind: "deny", message: APPROVAL_COMMAND_DENY_MESSAGE };
  }

  if (candidates.some((candidate) => isInteractiveOpenClawChannelLoginArgv(candidate.argv))) {
    return { kind: "deny", message: INTERACTIVE_CHANNEL_LOGIN_DENY_MESSAGE };
  }

  if (
    requiresSecurityAuditSuppressionApproval({
      command,
      candidates,
    })
  ) {
    return { kind: "requires-approval", warning: SECURITY_AUDIT_SUPPRESSION_WARNING };
  }

  return { kind: "allow" };
}
