// Walks project root, yields files to parse.
// Honors .gitignore + .synthraignore.
// TODO: M1

export interface WalkedFile {
  absPath: string;
  relPath: string;
  ext: string;
  size: number;
}

export async function* walk(_root: string): AsyncGenerator<WalkedFile> {
  throw new Error("Synthra: walk not yet implemented (M1)");
}
