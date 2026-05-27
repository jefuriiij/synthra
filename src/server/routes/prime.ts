// GET /prime — SessionStart hook calls this. Returns the priming text:
// project summary + recent stored context + CONTEXT.md narrative.
// TODO: M3

export interface PrimeResponse {
  primer: string;
  port: number;
}

export async function handlePrime(): Promise<PrimeResponse> {
  throw new Error("Synthra: handlePrime not yet implemented (M3)");
}
