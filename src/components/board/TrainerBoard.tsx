import { useEffect, useMemo, useRef, useState } from "react";
import type { Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import type { Arrow, CustomSquareStyles, Piece, PromotionPieceOption } from "react-chessboard/dist/chessboard/types";
import { applyMove, checkedKingSquare, isPromotion, legalTargets, sideToMove, type AppliedMove, type Color } from "../../core/chess/position";
import { useAppData } from "../../app/AppData";
import { playSound, soundFor } from "../../app/sounds";
import { BOARD_THEMES, MARK_STYLES, type SquareMark } from "./boardTheme";
import { useBoardWidth } from "./useBoardWidth";

export type BoardMove = Pick<AppliedMove, "from" | "to"> & Partial<Pick<AppliedMove, "captured" | "check" | "castle">>;

export interface TrainerBoardProps {
  id: string;
  fen: string;
  orientation: Color;
  /** The colour the user may move; null = no moves (e.g. while the app replies). */
  movable: Color | null;
  /** A legal move was made. Return false to refuse it (the piece goes back). */
  onMove?: (move: AppliedMove) => boolean | void;
  /**
   * The last move to highlight (pass the app's reply here so it is marked and makes its sound);
   * defaults to the last move made on this board.
   */
  lastMove?: BoardMove | null;
  arrows?: Arrow[];
  marks?: Partial<Record<string, SquareMark>>;
  /** Largest board size in px. */
  maxWidth?: number;
  /** Play move sounds for moves arriving through `fen` (opponent replies). */
  soundOnExternalMove?: boolean;
  /** Accessible name for the board region. */
  label?: string;
}

/**
 * The trainer's board: drag a piece, or tap it and then a target square. chess.js checks every
 * move; a promotion opens a piece picker for both input styles. Highlights: last move, check,
 * the picked piece with its legal targets, and any marks/arrows the exercise adds.
 */
export function TrainerBoard({
  id,
  fen,
  orientation,
  movable,
  onMove,
  lastMove,
  arrows = [],
  marks = {},
  maxWidth = 560,
  soundOnExternalMove = true,
  label = "Chessboard"
}: TrainerBoardProps) {
  const { settings } = useAppData();
  const boardSettings = settings.board;
  const volume = settings.sound.enabled ? settings.sound.volume : 0;
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useBoardWidth(wrapRef, maxWidth);
  const [picked, setPicked] = useState<Square | null>(null);
  const [ownLastMove, setOwnLastMove] = useState<BoardMove | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const [boardKey, setBoardKey] = useState(0);
  const previousFen = useRef(fen);
  const madeHere = useRef<string | null>(null);

  // A new position from outside clears the selection; a reply played by the app makes its sound.
  useEffect(() => {
    if (previousFen.current === fen) {
      return;
    }
    previousFen.current = fen;
    setPicked(null);
    setPendingPromotion(null);
    if (madeHere.current === fen) {
      madeHere.current = null;
      return;
    }
    setOwnLastMove(null);
    if (soundOnExternalMove && lastMove) {
      playSound(soundFor({ captured: lastMove.captured ?? null, check: lastMove.check ?? false, castle: lastMove.castle ?? null }), volume);
    }
  }, [fen, lastMove, soundOnExternalMove, volume]);

  const turn = sideToMove(fen);
  const canMove = movable !== null && movable === turn && onMove !== undefined;

  const tryMove = (from: Square, to: Square, promotion?: string): boolean => {
    if (!canMove || !onMove) {
      return false;
    }
    const move = applyMove(fen, { from, to, promotion });
    if (!move) {
      return false;
    }
    if (onMove(move) === false) {
      setPicked(null);
      return false;
    }
    madeHere.current = move.fenAfter;
    setOwnLastMove({ from, to });
    setPicked(null);
    playSound(soundFor(move), volume);
    return true;
  };

  const onPieceDrop = (from: Square, to: Square, piece: Piece): boolean => {
    setPicked(null);
    const promotion = isPromotion(fen, from, to) ? piece[1]?.toLowerCase() : undefined;
    return tryMove(from, to, promotion);
  };

  const onSquareClick = (square: Square, piece: Piece | undefined) => {
    if (!canMove) {
      return;
    }
    if (picked && picked !== square) {
      if (isPromotion(fen, picked, square)) {
        setPendingPromotion({ from: picked, to: square });
        return;
      }
      if (tryMove(picked, square)) {
        return;
      }
    }
    const own = piece !== undefined && piece[0] === (turn === "white" ? "w" : "b");
    setPicked(own && picked !== square ? square : null);
  };

  const onPromotionPieceSelect = (piece?: PromotionPieceOption, from?: Square, to?: Square): boolean => {
    const source = from ?? pendingPromotion?.from;
    const target = to ?? pendingPromotion?.to;
    setPendingPromotion(null);
    if (piece && source && target) {
      if (!tryMove(source, target, piece[1].toLowerCase())) {
        // A refused promotion would leave the library's dialog open: remount the board.
        setBoardKey((key) => key + 1);
      }
    }
    return false;
  };

  const targets = useMemo(() => (picked ? legalTargets(fen, picked) : []), [picked, fen]);
  const theme = BOARD_THEMES[boardSettings.theme];
  const shownLastMove = lastMove === undefined ? ownLastMove : (ownLastMove ?? lastMove);
  const check = checkedKingSquare(fen);

  const styles: CustomSquareStyles = {};
  if (boardSettings.highlightLastMove && shownLastMove) {
    styles[shownLastMove.from as Square] = { background: theme.lastMove };
    styles[shownLastMove.to as Square] = { background: theme.lastMove };
  }
  for (const [square, mark] of Object.entries(marks)) {
    if (mark) {
      styles[square as Square] = { ...styles[square as Square], ...MARK_STYLES[mark] };
    }
  }
  if (check) {
    styles[check] = { ...styles[check], background: "radial-gradient(circle, rgba(226, 70, 70, 0.85) 0%, rgba(226, 70, 70, 0.35) 45%, transparent 72%)" };
  }
  if (picked) {
    styles[picked] = { ...styles[picked], background: theme.selected };
    if (boardSettings.legalMoveDots) {
      for (const target of targets) {
        styles[target] = { ...styles[target], ...MARK_STYLES.target };
      }
    }
  }

  return (
    <div className="board-wrap" ref={wrapRef} role="group" aria-label={label}>
      {width > 0 ? (
        <Chessboard
          key={boardKey}
          id={id}
          position={fen}
          boardWidth={width}
          boardOrientation={orientation}
          showBoardNotation={boardSettings.coordinates}
          animationDuration={boardSettings.animationMs}
          areArrowsAllowed={false}
          arePremovesAllowed={false}
          isDraggablePiece={({ piece }) => canMove && piece[0] === (turn === "white" ? "w" : "b")}
          onPieceDrop={onPieceDrop}
          onSquareClick={onSquareClick}
          onPromotionPieceSelect={onPromotionPieceSelect}
          showPromotionDialog={pendingPromotion !== null}
          promotionToSquare={pendingPromotion?.to ?? null}
          promotionDialogVariant="modal"
          customArrows={arrows}
          customSquareStyles={styles}
          customDarkSquareStyle={{ backgroundColor: theme.dark }}
          customLightSquareStyle={{ backgroundColor: theme.light }}
          customBoardStyle={{ borderRadius: "8px", overflow: "hidden", boxShadow: "var(--shadow-board)" }}
        />
      ) : null}
    </div>
  );
}
