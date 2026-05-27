// Renders the final context pack as a single text blob for Claude.
// TODO: M2

export interface FormatInputs {
  signatures: string[];
  inlineBodies: string[];
  testFiles: string[];
  recentActivity?: string;
}

export function formatPack(_inputs: FormatInputs): string {
  throw new Error("Synthra: formatPack not yet implemented (M2)");
}
