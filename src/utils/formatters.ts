import type { GameResult, MoveCategory } from "../../shared/types";

export function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString("en-CA");
}

export function resultLabel(result: GameResult): string {
  if (result === "win") {
    return "Win";
  }

  if (result === "loss") {
    return "Loss";
  }

  return "Draw";
}

export function categoryLabel(category: MoveCategory): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}
