import { useEffect, useMemo, useState } from "react";
import { Chess, type Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import type { Arrow, CustomSquareStyles, Piece } from "react-chessboard/dist/chessboard/types";
import type { PlayerColor } from "../../shared/types";
import { boardColors, boardTheme } from "./boardTheme";

export interface PlayedMove {
  from: string;
  to: string;
  uci: string;
  san: string;
  fenBefore: string;
  fenAfter: string;
}

export interface PlayableBoardProps {
  id: string;
  /** The position to play from; a new value resets the board. Re-key the board to reset to the same one. */
  fen: string;
  orientation: PlayerColor;
  width: number;
  /** No moves accepted (e.g. while a move is being judged). */
  disabled?: boolean;
  /** A legal move was made; return false to refuse it (the piece snaps back). */
  onMove: (move: PlayedMove) => boolean | void;
  arrows?: Arrow[];
  squareStyles?: CustomSquareStyles;
}

/**
 * A board the owner can move on: drag a piece, or tap it and then its target square (the
 * fallback where touch drag is unreliable). chess.js checks legality and promotion defaults to a
 * queen; react-chessboard's quirks (the boolean drop result, the promotion dialog) stay in here.
 * The Review's Retry uses it, and the drills reuse it.
 */
export function PlayableBoard({ id, fen, orientation, width, disabled = false, onMove, arrows = [], squareStyles = {} }: PlayableBoardProps) {
  const [position, setPosition] = useState(fen);
  const [picked, setPicked] = useState<Square | null>(null);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);

  useEffect(() => {
    setPosition(fen);
    setPicked(null);
    setLastMove(null);
  }, [fen]);

  const turn = position.split(" ")[1];

  const tryMove = (from: Square, to: Square, promotion = "q"): boolean => {
    if (disabled) {
      return false;
    }
    const chess = new Chess(position);
    let move;
    try {
      move = chess.move({ from, to, promotion });
    } catch {
      return false;
    }
    const played: PlayedMove = {
      from,
      to,
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      san: move.san,
      fenBefore: position,
      fenAfter: chess.fen()
    };
    if (onMove(played) === false) {
      return false;
    }
    setPosition(played.fenAfter);
    setLastMove({ from, to });
    setPicked(null);
    return true;
  };

  const onPieceDrop = (from: Square, to: Square, piece: Piece): boolean => {
    setPicked(null);
    // With autoPromoteToQueen the dropped piece of a promotion is the new queen ("wQ").
    const promotion = piece[1]?.toLowerCase();
    return tryMove(from, to, promotion === "p" ? "q" : promotion);
  };

  const onSquareClick = (square: Square, piece: Piece | undefined) => {
    if (disabled) {
      return;
    }
    if (picked && picked !== square && tryMove(picked, square)) {
      return;
    }
    setPicked(piece && piece[0] === turn && picked !== square ? square : null);
  };

  const targets = useMemo(() => {
    if (!picked) {
      return [];
    }
    try {
      return new Chess(position).moves({ square: picked, verbose: true }).map((move) => move.to);
    } catch {
      return [];
    }
  }, [picked, position]);

  const styles: CustomSquareStyles = { ...squareStyles };
  if (lastMove) {
    styles[lastMove.from as Square] = { background: boardColors.selected };
    styles[lastMove.to as Square] = { background: boardColors.selected };
  }
  if (picked) {
    styles[picked] = { background: boardColors.selected };
    for (const target of targets) {
      styles[target] = { background: boardColors.target };
    }
  }

  return (
    <Chessboard
      id={id}
      position={position}
      boardWidth={width}
      boardOrientation={orientation}
      areArrowsAllowed={false}
      autoPromoteToQueen
      isDraggablePiece={({ piece }) => !disabled && piece[0] === turn}
      onPieceDrop={onPieceDrop}
      onSquareClick={onSquareClick}
      customArrows={arrows}
      customSquareStyles={styles}
      {...boardTheme}
    />
  );
}
