import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, ExternalLink, Timer, X, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { GameResult, TimeClass } from "../../shared/types";
import { fetchTreeGames, type TreeQuery } from "../api/client";
import { useStoreQuery } from "../hooks/useStoreQuery";
import { formatCount } from "../utils/formatters";

const timeClassMeta: Record<TimeClass, { label: string; fallback: string; Icon: LucideIcon }> = {
  blitz: { label: "Blitz", fallback: "3 min", Icon: Zap },
  rapid: { label: "Rapid", fallback: "10 min", Icon: Timer }
};

function formatDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  if (seconds >= 3600) {
    const hours = Math.round(seconds / 3600);
    return `${hours} hr${hours === 1 ? "" : "s"}`;
  }
  if (seconds >= 60) {
    return `${Math.round(seconds / 60)} min`;
  }
  return `${seconds} sec`;
}

/** "180+2" -> "3 min | 2", or the time class's usual control when unknown. */
function formatTimeControl(timeControl: string | undefined, timeClass: TimeClass): string {
  const fallback = timeClassMeta[timeClass].fallback;
  if (!timeControl) {
    return fallback;
  }
  const [base, increment] = timeControl.split("+").map(Number);
  const baseLabel = formatDuration(base) ?? fallback;
  return increment ? `${baseLabel} | ${increment}` : baseLabel;
}

function resultLabel(result: GameResult): string {
  return result === "win" ? "Win" : result === "loss" ? "Loss" : "Draw";
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export interface DrawerMove {
  /** The moves before the move, from the start. */
  moves: string[];
  uci: string;
  /** "1...e5" */
  label: string;
  n: number;
}

/**
 * The games behind one move row, newest first, 20 per page from GET /api/tree/games. Each game
 * opens its opening review at the move's ply, or the game on Chess.com.
 */
export function GamesDrawer({ tree, move, onClose }: { tree: TreeQuery; move: DrawerMove; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const { data, error, loading } = useStoreQuery(
    (signal) => fetchTreeGames(tree, move.moves, move.uci, page, signal),
    [tree.color, tree.window, tree.timeClass, tree.weighted, move.moves.join(","), move.uci, page]
  );

  // A new page starts at the top of the list.
  useEffect(() => {
    drawerRef.current?.scrollTo({ top: 0 });
  }, [data?.page]);

  useEffect(() => {
    closeRef.current?.focus();
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <>
      <button className="drawer-backdrop" type="button" aria-label="Close the games list" tabIndex={-1} onClick={onClose} />
      <aside ref={drawerRef} className="games-drawer" role="dialog" aria-modal="true" aria-label={`Games with ${move.label}`}>
        <header className="games-drawer-header">
          <div>
            <span className="eyebrow">Games with</span>
            <h2>
              {move.label} <span className="games-drawer-count">· {formatCount(data?.total ?? move.n)} games</span>
            </h2>
          </div>
          <button ref={closeRef} className="icon-button" type="button" aria-label="Close the games list" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        {error ? <p className="error-text">Could not load the games: {error}</p> : null}

        <ol className={`games-list${loading ? " games-list-loading" : ""}`}>
          {(data?.games ?? []).map((game) => {
            const { Icon, label } = timeClassMeta[game.timeClass];
            const review = `/review/${encodeURIComponent(game.id)}${game.ply ? `?ply=${game.ply}` : ""}`;
            return (
              <li key={game.id} className="games-list-row">
                <span className={`result-badge result-badge-${game.result}`} title={resultLabel(game.result)}>
                  {game.result === "win" ? "W" : game.result === "loss" ? "L" : "D"}
                </span>
                <div className="games-list-main">
                  <strong className="games-list-opponent">
                    {game.oppName} <span className="cell-sub">({game.oppRating})</span>
                  </strong>
                  <span className="games-list-meta">
                    <span className={`time-class-${game.timeClass}`} title={label}>
                      <Icon size={14} aria-hidden="true" />
                    </span>
                    {formatTimeControl(game.timeControl, game.timeClass)} · {formatDate(game.endTime)}
                  </span>
                </div>
                <div className="games-list-actions">
                  <Link className="secondary-button games-list-review" to={review}>
                    Review
                  </Link>
                  <a
                    className="icon-button"
                    href={game.url}
                    target="_blank"
                    rel="noreferrer"
                    title="Open on Chess.com"
                    aria-label={`Open the game vs ${game.oppName} on Chess.com`}
                  >
                    <ExternalLink size={16} />
                  </a>
                </div>
              </li>
            );
          })}
        </ol>

        {data && data.pages > 1 ? (
          <nav className="games-pager" aria-label="Pages">
            <button className="icon-button" type="button" disabled={page <= 1} aria-label="Previous page" onClick={() => setPage(page - 1)}>
              <ChevronLeft size={18} />
            </button>
            <span>
              Page {data.page} of {data.pages}
            </span>
            <button
              className="icon-button"
              type="button"
              disabled={page >= data.pages}
              aria-label="Next page"
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight size={18} />
            </button>
          </nav>
        ) : null}
      </aside>
    </>
  );
}
