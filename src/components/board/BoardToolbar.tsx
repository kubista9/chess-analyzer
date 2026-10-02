import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, FlipVertical2, RotateCcw, Undo2 } from "lucide-react";

export interface BoardToolbarProps {
  onFlip?: () => void;
  onUndo?: () => void;
  onReset?: () => void;
  onStart?: () => void;
  onBack?: () => void;
  onForward?: () => void;
  onEnd?: () => void;
  canUndo?: boolean;
  canReset?: boolean;
  canBack?: boolean;
  canForward?: boolean;
}

/** Board controls; only the handlers given are shown. Keyboard: F flip, ← → step, Home/End. */
export function BoardToolbar({ onFlip, onUndo, onReset, onStart, onBack, onForward, onEnd, canUndo = true, canReset = true, canBack = true, canForward = true }: BoardToolbarProps) {
  return (
    <div className="board-toolbar" role="toolbar" aria-label="Board controls">
      {onStart ? (
        <button type="button" className="icon-button" onClick={onStart} disabled={!canBack} aria-label="Go to the start (Home)" title="Start (Home)">
          <ChevronFirst size={18} aria-hidden="true" />
        </button>
      ) : null}
      {onBack ? (
        <button type="button" className="icon-button" onClick={onBack} disabled={!canBack} aria-label="Back one move (←)" title="Back (←)">
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
      ) : null}
      {onForward ? (
        <button type="button" className="icon-button" onClick={onForward} disabled={!canForward} aria-label="Forward one move (→)" title="Forward (→)">
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      ) : null}
      {onEnd ? (
        <button type="button" className="icon-button" onClick={onEnd} disabled={!canForward} aria-label="Go to the last move (End)" title="End (End)">
          <ChevronLast size={18} aria-hidden="true" />
        </button>
      ) : null}
      {onUndo ? (
        <button type="button" className="icon-button" onClick={onUndo} disabled={!canUndo} aria-label="Take back a move" title="Take back">
          <Undo2 size={18} aria-hidden="true" />
        </button>
      ) : null}
      {onReset ? (
        <button type="button" className="icon-button" onClick={onReset} disabled={!canReset} aria-label="Reset the board" title="Reset">
          <RotateCcw size={18} aria-hidden="true" />
        </button>
      ) : null}
      {onFlip ? (
        <button type="button" className="icon-button" onClick={onFlip} aria-label="Flip the board (F)" title="Flip (F)">
          <FlipVertical2 size={18} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
