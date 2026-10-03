import { useId, useState, type FormEvent } from "react";
import { applyMove, type AppliedMove } from "../../core/chess/position";

export interface MoveInputProps {
  fen: string;
  disabled?: boolean;
  /** Same contract as the board: return false to refuse the move. */
  onMove: (move: AppliedMove) => boolean | void;
}

/**
 * A keyboard way to play a move: type it in SAN ("Nf3", "O-O", "exd5") or UCI ("g1f3") and press
 * Enter. The board itself is pointer-only, so this is the accessible path for every exercise.
 */
export function MoveInput({ fen, disabled = false, onMove }: MoveInputProps) {
  const id = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) {
      return;
    }
    const move = applyMove(fen, value);
    if (!move) {
      setError(`"${value}" is not a legal move here.`);
      return;
    }
    setError(null);
    setText("");
    onMove(move);
  };

  return (
    <form className="move-input" onSubmit={submit}>
      <label className="visually-hidden" htmlFor={id}>
        Type a move
      </label>
      <input
        id={id}
        className="input"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        placeholder="Type a move, e.g. Nf3"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      <button type="submit" className="button button-small" disabled={disabled || text.trim() === ""}>
        Play
      </button>
      {error ? (
        <p id={`${id}-error`} className="move-input-error error-text small" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
