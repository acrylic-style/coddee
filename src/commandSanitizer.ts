const MAX_SANITIZED_COMMAND_LENGTH = 500;

const SSH_OPTIONS_WITH_VALUE = new Set([
  "-B",
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-I",
  "-i",
  "-J",
  "-L",
  "-l",
  "-m",
  "-O",
  "-o",
  "-P",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w",
]);

export function sanitizeCommandForSummary(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "command";
  }

  const sshSummary = sanitizeSshCommand(normalized);
  const sanitized = redactSensitiveFragments(sshSummary ?? normalized)
    .replace(/\s+/g, " ")
    .trim();

  if (!sanitized) {
    return "command <redacted>";
  }
  return sanitized.length <= MAX_SANITIZED_COMMAND_LENGTH
    ? sanitized
    : `${sanitized.slice(0, MAX_SANITIZED_COMMAND_LENGTH - 3)}...`;
}

function sanitizeSshCommand(command: string): string | null {
  const match = /(?:^|[\s"';&|])ssh(?:\.exe)?(?=\s)/i.exec(command);
  if (!match || match.index === undefined) {
    return null;
  }

  const sshStart = match.index + match[0].search(/ssh/i);
  const tokens = tokenizeCommand(command.slice(sshStart));
  if (tokens.length === 0 || !/^ssh(?:\.exe)?$/i.test(tokens[0] ?? "")) {
    return null;
  }

  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (!token.startsWith("-")) {
      break;
    }

    const option = token.slice(0, 2);
    index += 1;
    if (SSH_OPTIONS_WITH_VALUE.has(option) && token.length === 2) {
      index += 1;
    }
  }

  if (index >= tokens.length) {
    return "ssh <destination>";
  }

  const remoteCommand = tokens
    .slice(index + 1)
    .map(stripMatchingQuotes)
    .join(" ")
    .trim();
  return remoteCommand
    ? `ssh <destination> ${remoteCommand}`
    : "ssh <destination>";
}

function tokenizeCommand(command: string): string[] {
  return command.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g) ?? [];
}

function stripMatchingQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function redactSensitiveFragments(command: string): string {
  return command
    .replace(
      /(\$env:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      "$1<redacted>",
    )
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      "$1=<redacted>",
    )
    .replace(
      /(--(?:password|passwd|token|api[-_]?key|secret|private[-_]?key|credential|authorization))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      "$1=<redacted>",
    )
    .replace(
      /(^|\s)(--user|--proxy-user|-u)(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      "$1$2=<redacted>",
    )
    .replace(
      /((?:-H|--header)\s+)(?:"|')?Authorization\s*:\s*[^"';&|]+(?:"|')?/gi,
      "$1Authorization: <redacted>",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>")
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"';&|]+/g, "<url>")
    .replace(
      /\b[A-Za-z0-9._-]+@(?:\[[^\]]+\]|[A-Za-z0-9._:-]+)/g,
      "<destination>",
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<host>")
    .replace(/\b[A-Za-z]:\\[^\s"';&|]*/g, "<path>")
    .replace(/(^|\s)\/(?:[^\s"';&|/]+\/)*[^\s"';&|]*/g, "$1<path>")
    .replace(
      /\b(?=[A-Za-z0-9._~+/=-]{24,}\b)(?=[A-Za-z0-9._~+/=-]*[A-Za-z])(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]+/g,
      "<redacted>",
    );
}
