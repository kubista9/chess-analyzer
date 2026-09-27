import { GAME_WINDOWS, type GameWindow } from "../../shared/window";
import { useWorkspace } from "../hooks/useWorkspace";

const labels: Record<GameWindow, string> = { "6m": "Last 6 months", "3m": "Last 3 months" };

/** The 6-month / 3-month window filter, shared by the Opening Report and Game History. */
export function WindowToggle() {
  const { gameWindow, setGameWindow } = useWorkspace();

  return (
    <div className="limit-toggle window-toggle" role="group" aria-label="Time window">
      {(Object.keys(GAME_WINDOWS) as GameWindow[]).map((option) => (
        <button
          key={option}
          type="button"
          className={`limit-chip${gameWindow === option ? " limit-chip-active" : ""}`}
          aria-pressed={gameWindow === option}
          onClick={() => setGameWindow(option)}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}
