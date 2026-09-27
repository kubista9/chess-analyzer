import type { MoveCategory } from "./types.js";

/** The review note for a move. Second-person copy is used only for the owner's own moves. */
export function noteForCategory(category: MoveCategory, lossWinPct: number, isOwnerMove: boolean): string {
  const loss = `${lossWinPct.toFixed(1)}% engine win chance`;
  switch (category) {
    case "best":
      return isOwnerMove
        ? "Engine agrees with your move. This kept the position on the cleanest path."
        : "Engine agrees with this move.";
    case "good":
      return `Playable, but the engine prefers another move (-${loss}).`;
    case "inaccuracy":
      return `An inaccuracy: a better move was available (-${loss}).`;
    case "mistake":
      return `A mistake that gives the other side real chances (-${loss}).`;
    case "blunder":
      return `A blunder: this swings the game (-${loss}).`;
  }
}
