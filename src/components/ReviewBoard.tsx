import { Chessboard } from "react-chessboard";
import type { Arrow, CustomSquareStyles } from "react-chessboard/dist/chessboard/types";
import type { PlayerColor } from "../../shared/types";
import { boardTheme } from "./boardTheme";

export interface ReviewBoardProps {
  id: string;
  fen: string;
  orientation: PlayerColor;
  width: number;
  arrows?: Arrow[];
  squareStyles?: CustomSquareStyles;
}

/** A read-only board: a position to look at, with arrows and highlights. */
export function ReviewBoard({ id, fen, orientation, width, arrows = [], squareStyles = {} }: ReviewBoardProps) {
  return (
    <Chessboard
      id={id}
      position={fen}
      boardWidth={width}
      boardOrientation={orientation}
      arePiecesDraggable={false}
      areArrowsAllowed={false}
      customArrows={arrows}
      customSquareStyles={squareStyles}
      {...boardTheme}
    />
  );
}
