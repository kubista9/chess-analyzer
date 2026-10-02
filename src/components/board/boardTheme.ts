import type { BoardTheme } from "../../core/training/types";

// Board colours per theme (Settings → Board) and the square marks exercises use.

export interface BoardColours {
  label: string;
  dark: string;
  light: string;
  lastMove: string;
  selected: string;
}

export const BOARD_THEMES: Record<BoardTheme, BoardColours> = {
  green: { label: "Green", dark: "#769656", light: "#eeeed2", lastMove: "rgba(246, 246, 105, 0.55)", selected: "rgba(246, 246, 105, 0.7)" },
  brown: { label: "Brown", dark: "#b58863", light: "#f0d9b5", lastMove: "rgba(205, 210, 106, 0.7)", selected: "rgba(170, 162, 58, 0.75)" },
  blue: { label: "Blue", dark: "#7393b3", light: "#dfe6ee", lastMove: "rgba(155, 199, 0, 0.5)", selected: "rgba(155, 199, 0, 0.65)" },
  grey: { label: "Grey", dark: "#8a8a8a", light: "#d9d9d9", lastMove: "rgba(120, 170, 220, 0.55)", selected: "rgba(120, 170, 220, 0.7)" }
};

export type SquareMark = "hint" | "book" | "alternative" | "mistake" | "target";

/** Overlays merged over a square's own style. */
export const MARK_STYLES: Record<SquareMark, Record<string, string>> = {
  hint: { boxShadow: "inset 0 0 0 4px rgba(242, 201, 76, 0.95)" },
  book: { boxShadow: "inset 0 0 0 4px rgba(140, 191, 85, 0.95)" },
  alternative: { boxShadow: "inset 0 0 0 4px rgba(106, 174, 232, 0.95)" },
  mistake: { boxShadow: "inset 0 0 0 4px rgba(226, 109, 109, 0.95)" },
  target: { backgroundImage: "radial-gradient(circle, rgba(20, 20, 20, 0.32) 22%, transparent 24%)" }
};

/** Arrow colours: the solution, the engine's suggestion, and a played move. */
export const ARROW_COLOURS = {
  solution: "rgba(140, 191, 85, 0.9)",
  engine: "rgba(106, 174, 232, 0.85)",
  played: "rgba(226, 109, 109, 0.8)"
} as const;
