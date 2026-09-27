import type { GameResult } from "../../shared/types";

export function resultLabel(result: GameResult): string {
  if (result === "win") {
    return "Win";
  }

  if (result === "loss") {
    return "Loss";
  }

  return "Draw";
}
