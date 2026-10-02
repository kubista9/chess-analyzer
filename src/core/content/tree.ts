import { posKey, type Line } from "./types";

// The repertoire as a position graph. (buildTree and the walkers are added with the content
// compiler; linePositionKeys is needed by the training modules too.)

/** posKey of the position before each of the user's moves in a line, in order, without repeats. */
export function linePositionKeys(line: Line): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const ply of line.userPlies) {
    const key = posKey(line.side, line.epds[ply - 1]);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}
