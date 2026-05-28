// Renders the final context pack as a single Markdown blob for Claude.

export interface FormatFileSection {
  path: string;
  reason?: string;
  signatures: string[];
  inlineBodies: string;
  associatedTests?: string[];
}

export interface FormatInputs {
  query: string;
  files: FormatFileSection[];
  recentActivity?: string;
  truncated?: boolean;
}

export function formatPack(inputs: FormatInputs): string {
  const parts: string[] = [];
  parts.push(`# Synthra context — query: ${JSON.stringify(inputs.query)}\n`);

  if (inputs.files.length === 0) {
    parts.push("> No matching files found in the graph.\n");
  }

  for (const f of inputs.files) {
    const heading = f.reason ? `## ${f.path}  _(${f.reason})_` : `## ${f.path}`;
    parts.push(heading);

    if (f.signatures.length === 0) {
      parts.push("_(no symbols extracted)_");
    } else {
      parts.push("**Signatures:**");
      for (const s of f.signatures) parts.push(`- ${s}`);
    }

    if (f.inlineBodies.trim().length > 0) {
      parts.push("");
      parts.push("**Bodies:**");
      parts.push("```");
      parts.push(f.inlineBodies.trimEnd());
      parts.push("```");
    }

    if (f.associatedTests?.length) {
      parts.push("");
      parts.push(`**Tests:** ${f.associatedTests.join(", ")}`);
    }

    parts.push("");
  }

  if (inputs.recentActivity?.trim()) {
    parts.push("---");
    parts.push("## Recent human activity");
    parts.push(inputs.recentActivity.trim());
    parts.push("");
  }

  if (inputs.truncated) {
    parts.push("> _(pack truncated to fit budget)_");
  }

  return parts.join("\n");
}
