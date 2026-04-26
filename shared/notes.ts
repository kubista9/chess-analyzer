import type { MoveCategory } from "./types.js";

export function noteForCategory(category: MoveCategory, lossCp: number): string {
  switch (category) {
    case "brilliant":
      return "You found a concrete resource that keeps the engine's top evaluation and carries tactical bite.";
    case "great":
      return "This was one of the few moves that kept the position under control when things could have slipped.";
    case "best":
      return "Engine agrees with your move. This kept the position on the cleanest path.";
    case "good":
      return `Playable and practical, but the engine still sees a stronger continuation worth studying (${Math.round(
        lossCp
      )} cp).`;
    case "mistake":
      return `This dropped the evaluation enough to give your opponent a real chance (${Math.round(lossCp)} cp).`;
    case "miss":
      return "A stronger tactical or strategic shot was available here, and missing it changed the momentum.";
    case "blunder":
      return "This was the turning point. The move allowed a major evaluation swing or lost a winning position.";
  }
}
