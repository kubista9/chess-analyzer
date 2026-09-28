// The chess.com-like board colours shared by the Explorer and the review boards.
export const boardTheme = {
  customDarkSquareStyle: { backgroundColor: "#779954" },
  customLightSquareStyle: { backgroundColor: "#eeeed2" },
  customBoardStyle: {
    borderRadius: "10px",
    overflow: "hidden",
    boxShadow: "0 24px 40px rgba(0, 0, 0, 0.32)"
  }
};

/** Arrow and highlight colours. */
export const boardColors = {
  arrow: "rgba(163, 209, 96, 0.85)",
  /** The engine's best move. */
  best: "rgba(92, 170, 240, 0.8)",
  selected: "rgba(247, 201, 72, 0.45)",
  target: "radial-gradient(circle, rgba(31, 30, 28, 0.35) 24%, transparent 26%)"
};
