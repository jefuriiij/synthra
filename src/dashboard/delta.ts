// Computes "estimated savings vs no-Synthra" — improvement #4.
// Uses blocked-Grep counts and average tokens-per-Grep to estimate what
// the conversation would have cost without Synthra's PreToolUse gate.
// TODO: M6

export interface TurnBreakdown {
  systemPromptTokens: number;
  conversationHistoryTokens: number;
  synthraPackTokens: number;
  userMessageTokens: number;
  responseTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface SavingsDelta {
  withSynthra: TurnBreakdown;
  estimatedWithoutSynthra: TurnBreakdown;
  savedUsd: number;
  savedPercent: number;
}

export function computeDelta(_breakdown: TurnBreakdown, _blockedGreps: number): SavingsDelta {
  throw new Error("Synthra: computeDelta not yet implemented (M6)");
}
