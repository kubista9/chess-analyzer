import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import type { Arrow, CustomSquareStyles, Piece, Square } from "react-chessboard/dist/chessboard/types";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { OPENING_PLY_LIMIT } from "../../shared/constants";
import { REPERTOIRE_MAX_PLY, repTag } from "../../shared/repertoire";
import { tagText } from "../components/RepTag";
import type { PlayerColor, TreeEdgeView } from "../../shared/types";
import { fetchTreeNode, putRepEntry, type TreeQuery } from "../api/client";
import { boardColors, boardTheme } from "../components/boardTheme";
import { FilterBar } from "../components/FilterBar";
import { GamesDrawer, type DrawerMove } from "../components/GamesDrawer";
import { MoveTable, moveLabel } from "../components/MoveTable";
import { NodeEngine } from "../components/NodeEngine";
import { alternativesHref } from "../components/AlternativesPanel";
import { useFilters } from "../hooks/useFilters";
import { useStoreQuery } from "../hooks/useStoreQuery";
import { useWorkspace } from "../hooks/useWorkspace";
import { formatCount } from "../utils/formatters";
import "../styles/explorer.css";
import "../styles/repertoire.css";

interface ReplayedLine {
  /** The legal prefix of the requested UCI moves. */
  moves: string[];
  sans: string[];
  fen: string;
}

/** Replays comma-separated UCI moves from the start, stopping at the first illegal one. */
function replayLine(raw: string | readonly string[]): ReplayedLine {
  const requested = typeof raw === "string" ? (raw ? raw.split(",") : []) : raw;
  const chess = new Chess();
  const moves: string[] = [];
  const sans: string[] = [];
  for (const uci of requested.slice(0, OPENING_PLY_LIMIT)) {
    try {
      const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      moves.push(uci);
      sans.push(move.san);
    } catch {
      break;
    }
  }
  return { moves, sans, fen: chess.fen() };
}

const isPrefix = (prefix: readonly string[], line: readonly string[]) =>
  prefix.length <= line.length && prefix.every((uci, index) => line[index] === uci);

export function ExplorerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const color: PlayerColor = searchParams.get("color") === "black" ? "black" : "white";
  const rawMoves = searchParams.get("moves") ?? "";
  const line = useMemo(() => replayLine(rawMoves), [rawMoves]);
  const movesKey = line.moves.join(",");
  const [filters, setFilters] = useFilters();
  const { dataVersion } = useWorkspace();
  const tree = useMemo<TreeQuery>(
    () => ({ color, window: filters.window, timeClass: filters.timeClass ?? undefined, weighted: filters.weighted }),
    [color, filters.window, filters.timeClass, filters.weighted]
  );
  // Bumped after a repertoire edit, so the node's entry is read again.
  const [repVersion, setRepVersion] = useState(0);
  const [repBusy, setRepBusy] = useState(false);
  const { data, error, loading } = useStoreQuery(
    (signal) => fetchTreeNode(tree, line.moves, signal),
    [tree, movesKey, dataVersion, repVersion]
  );
  // The furthest line walked from here, so Forward can retrace it after Back.
  const [forwardLine, setForwardLine] = useState<string[]>(line.moves);
  const forward = useMemo(() => replayLine(forwardLine), [forwardLine]);
  const [selected, setSelected] = useState(0);
  const [pendingSquare, setPendingSquare] = useState<Square | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerMove | null>(null);

  // The answer for exactly these filters and this path (a previous answer stays visible, dimmed, while loading).
  const fresh = Boolean(
    data &&
      !error &&
      data.color === color &&
      data.window.key === filters.window &&
      data.timeClass === filters.timeClass &&
      data.path.map((step) => step.uci).join(",") === movesKey
  );
  const node = data && !error ? data.node : null;
  const edges = fresh && node ? node.edges : [];
  const ply = line.moves.length + 1;
  const repEntry = fresh ? data?.repertoire ?? null : null;

  // "Set as my move": an edited, locked repertoire entry for this position.
  const setAsMyMove = useCallback(
    async (edge: TreeEdgeView) => {
      if (!node) {
        return;
      }
      setRepBusy(true);
      try {
        await putRepEntry({ color, epd: node.epd, uci: edge.uci, ply });
        setNotice(`${moveLabel(ply, edge.san)} is now your repertoire move here.`);
        setRepVersion((version) => version + 1);
      } catch (caught) {
        setNotice(`Could not set the move: ${caught instanceof Error ? caught.message : String(caught)}`);
      } finally {
        setRepBusy(false);
      }
    },
    [color, node, ply]
  );

  // An illegal or over-long ?moves= is trimmed to its legal prefix.
  useEffect(() => {
    if (movesKey !== rawMoves) {
      setSearchParams(
        (params) => {
          const next = new URLSearchParams(params);
          if (movesKey) {
            next.set("moves", movesKey);
          } else {
            next.delete("moves");
          }
          return next;
        },
        { replace: true }
      );
    }
  }, [movesKey, rawMoves, setSearchParams]);

  // The path last asked for. Router navigations commit in a transition, so a second quick
  // Back/Forward would otherwise still see the previous path and repeat the same step.
  const latestMoves = useRef(line.moves);
  useEffect(() => {
    latestMoves.current = line.moves;
  }, [line.moves]);

  const goTo = useCallback(
    (moves: string[]) => {
      latestMoves.current = moves;
      setForwardLine((current) => (isPrefix(moves, current) ? current : moves));
      setSelected(0);
      setPendingSquare(null);
      setNotice(null);
      setDrawer(null);
      setSearchParams(
        (params) => {
          const next = new URLSearchParams(params);
          next.delete("select");
          if (moves.length) {
            next.set("moves", moves.join(","));
          } else {
            next.delete("moves");
          }
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  // ?select=<uci> (links from Home and Leaks) highlights that move's row once the node loads.
  const selectUci = searchParams.get("select");
  useEffect(() => {
    if (!selectUci || !fresh) {
      return;
    }
    const index = edges.findIndex((edge) => edge.uci === selectUci);
    if (index >= 0) {
      setSelected(index);
    }
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.delete("select");
        return next;
      },
      { replace: true }
    );
  }, [edges, fresh, selectUci, setSearchParams]);

  const setColor = (next: PlayerColor) => {
    if (next === color) {
      return;
    }
    setForwardLine([]);
    setSelected(0);
    setDrawer(null);
    setNotice(null);
    setSearchParams({ color: next }, { replace: true });
  };

  const follow = useCallback((edge: TreeEdgeView) => goTo([...line.moves, edge.uci]), [goTo, line.moves]);
  const back = useCallback(() => {
    const current = latestMoves.current;
    if (current.length) {
      goTo(current.slice(0, -1));
    }
  }, [goTo]);
  const stepForward = useCallback(() => {
    const current = latestMoves.current;
    if (forward.moves.length > current.length && isPrefix(current, forward.moves)) {
      goTo(forward.moves.slice(0, current.length + 1));
    } else if (edges.length && current.length === line.moves.length) {
      // Off the retraced line: the selected (by default the most-played) move.
      follow(edges[Math.min(selected, edges.length - 1)]);
    }
  }, [edges, follow, forward.moves, goTo, line.moves.length, selected]);
  // The breadcrumbs show the path and, after Back, the moves Forward would retrace.
  const trail = isPrefix(line.moves, forward.moves) ? forward : line;
  const canForward = (forward.moves.length > line.moves.length && isPrefix(line.moves, forward.moves)) || edges.length > 0;

  const showGames = useCallback(
    (edge: TreeEdgeView) => setDrawer({ moves: line.moves, uci: edge.uci, label: moveLabel(ply, edge.san), n: edge.n }),
    [line.moves, ply]
  );
  const closeDrawer = useCallback(() => setDrawer(null), []);

  // ←/→: parent / forward; ↑/↓ select a row; Enter follows it.
  useEffect(() => {
    if (drawer) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, select, textarea")) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        back();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        stepForward();
      } else if (event.key === "ArrowUp" && edges.length) {
        event.preventDefault();
        setSelected((index) => Math.max(0, index - 1));
      } else if (event.key === "ArrowDown" && edges.length) {
        event.preventDefault();
        setSelected((index) => Math.min(edges.length - 1, index + 1));
      } else if (event.key === "Enter" && edges.length && !target?.closest("button, a")) {
        event.preventDefault();
        follow(edges[Math.min(selected, edges.length - 1)]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back, drawer, edges, follow, selected, stepForward]);

  // A move made on the board descends the tree if the games played it.
  const tryMove = (from: Square, to: Square, promotion = "q"): boolean => {
    const matches = edges.filter((edge) => edge.uci.slice(0, 4) === `${from}${to}`);
    const edge = matches.find((candidate) => candidate.uci.length === 4 || candidate.uci[4] === promotion) ?? matches[0];
    if (edge) {
      follow(edge);
      return true;
    }
    try {
      const move = new Chess(line.fen).move({ from, to, promotion });
      setNotice(`No game in these filters played ${moveLabel(ply, move.san)} here.`);
    } catch {
      // Not a legal move: the board snaps the piece back.
    }
    return false;
  };

  const turn = line.fen.split(" ")[1];
  const onPieceDrop = (from: Square, to: Square, piece: Piece) => {
    setPendingSquare(null);
    return fresh ? tryMove(from, to, piece[1]?.toLowerCase()) : false;
  };
  const onSquareClick = (square: Square, piece: Piece | undefined) => {
    if (!fresh) {
      return;
    }
    if (pendingSquare && pendingSquare !== square && tryMove(pendingSquare, square)) {
      return;
    }
    setPendingSquare(piece && piece[0] === turn && pendingSquare !== square ? square : null);
  };

  const selectedEdge = edges[Math.min(selected, edges.length - 1)];
  const arrows: Arrow[] = selectedEdge ? [[selectedEdge.uci.slice(0, 2) as Square, selectedEdge.uci.slice(2, 4) as Square, boardColors.arrow]] : [];
  // The engine's move at the owner's own positions (unless it is the selected row's arrow already).
  const bestUci = fresh && node?.ownerToMove ? node.engine?.bestUci : null;
  if (bestUci && bestUci !== selectedEdge?.uci) {
    arrows.push([bestUci.slice(0, 2) as Square, bestUci.slice(2, 4) as Square, boardColors.best]);
  }
  const squareStyles: CustomSquareStyles = {};
  if (pendingSquare) {
    squareStyles[pendingSquare] = { background: boardColors.selected };
    for (const edge of edges.filter((candidate) => candidate.uci.startsWith(pendingSquare))) {
      squareStyles[edge.uci.slice(2, 4) as Square] = { background: boardColors.target };
    }
  }

  const weighted = data?.halfLifeDays !== null && data?.halfLifeDays !== undefined;
  const scope = [
    color === "white" ? "As White" : "As Black",
    filters.window === "3m" ? "last 3 months" : "last 6 months",
    filters.timeClass ?? "blitz + rapid",
    weighted ? `recent games count more (half-life ${data?.halfLifeDays} days)` : "unweighted"
  ].join(" · ");
  const endedHere = node && fresh ? node.ended : 0;

  return (
    <div className="page-content explorer-page">
      <section className="page-header">
        <div>
          <span className="eyebrow">Opening explorer</span>
          <h1>Explorer</h1>
          <p>
            Your {data ? `${formatCount(data.games)} ` : ""}games as {color === "white" ? "White" : "Black"}, walked move by move
            over the first {OPENING_PLY_LIMIT / 2} moves. Positions merge across move orders. Scores are compared with your Elo
            expectation; a row is coloured only when the difference is well above noise.
          </p>
        </div>
      </section>

      <FilterBar color={color} onColorChange={setColor} filters={filters} onFiltersChange={setFilters} />

      <div className="explorer-grid">
        <section className="panel explorer-board-panel" aria-label="Board">
          <div className="explorer-board">
            <Chessboard
              id="explorer-board"
              position={line.fen}
              boardOrientation={color}
              areArrowsAllowed={false}
              autoPromoteToQueen
              isDraggablePiece={({ piece }) => fresh && piece[0] === turn}
              onPieceDrop={onPieceDrop}
              onSquareClick={onSquareClick}
              customArrows={arrows}
              customSquareStyles={squareStyles}
              {...boardTheme}
            />
          </div>
          <div className="explorer-controls">
            <button className="icon-button" type="button" title="Start position" aria-label="Start position" disabled={!line.moves.length} onClick={() => goTo([])}>
              <RotateCcw size={18} />
            </button>
            <button className="icon-button" type="button" title="Back (←)" aria-label="Back one move" disabled={!line.moves.length} onClick={back}>
              <ChevronLeft size={20} />
            </button>
            <button className="icon-button" type="button" title="Forward (→)" aria-label="Forward one move" disabled={!canForward} onClick={stepForward}>
              <ChevronRight size={20} />
            </button>
            <span className="explorer-keys">← → ↑ ↓ Enter</span>
          </div>
        </section>

        <section className="panel explorer-node-panel" aria-label="Position">
          <nav className="breadcrumbs" aria-label="Move path">
            <button type="button" className={`crumb${line.moves.length ? "" : " crumb-current"}`} onClick={() => goTo([])}>
              Start
            </button>
            {trail.sans.map((san, index) => {
              const step = data?.path[index];
              return (
                <button
                  key={`${index}-${trail.moves[index]}`}
                  type="button"
                  className={`crumb${index === line.moves.length - 1 ? " crumb-current" : ""}${index >= line.moves.length ? " crumb-ahead" : ""}`}
                  title={step ? `${formatCount(step.n)} games${step.name ? ` · ${step.eco} ${step.name}` : ""}` : undefined}
                  onClick={() => goTo(trail.moves.slice(0, index + 1))}
                >
                  {index % 2 === 0 ? `${index / 2 + 1}.${san}` : san}
                </button>
              );
            })}
          </nav>

          {node ? (
            <div className={`node-summary${fresh ? "" : " is-stale"}`}>
              <div className="node-name">
                {node.eco ? <span className="eco-badge">{node.eco}</span> : null}
                <h2>{node.name ?? (line.moves.length ? "Unnamed position" : "Starting position")}</h2>
              </div>
              <p className="node-name-note">
                {!line.moves.length
                  ? "Pick a move below or play one on the board."
                  : !node.inBook
                  ? "Out of book: this position is not on any named line."
                  : node.name && !node.nameExact
                    ? "A book position without its own name; the name is the last named line on the way."
                    : node.name
                      ? "Named line in the lichess chess-openings list (a name, not a recommendation)."
                      : "On a named line."}
              </p>
              <dl className="node-stats">
                <div>
                  <dt>Games here</dt>
                  <dd>{formatCount(node.n)}</dd>
                </div>
                <div>
                  <dt>To move</dt>
                  <dd>{node.ownerToMove ? "You" : "Opponent"}</dd>
                </div>
                {weighted ? (
                  <div title="Effective n under the recency weights">
                    <dt>ESS</dt>
                    <dd>{Math.round(node.ess)}</dd>
                  </div>
                ) : null}
                {endedHere ? (
                  <div title={`Games that stopped here: the game ended, or the tree's ${OPENING_PLY_LIMIT}-ply limit`}>
                    <dt>Stopped here</dt>
                    <dd>{formatCount(endedHere)}</dd>
                  </div>
                ) : null}
              </dl>
              <NodeEngine node={node} coverage={data?.engine ?? null} color={color} />
              {node.ownerToMove && ply <= REPERTOIRE_MAX_PLY ? (
                <p className="rep-node-note">
                  {repEntry ? (
                    <>
                      Repertoire: <strong>{moveLabel(ply, repEntry.san)}</strong> ({tagText(repTag(repEntry), repEntry.ply)}
                      {repEntry.status === "needs-review" ? ", needs review" : ""}).{" "}
                    </>
                  ) : (
                    "No repertoire move here yet. "
                  )}
                  <Link to={`/repertoire?color=${color}`}>Open the repertoire</Link> ·{" "}
                  <Link to={alternativesHref(color, line.moves, repEntry?.uci ?? null)}>See alternatives</Link>
                </p>
              ) : null}
            </div>
          ) : null}

          <p className="explorer-scope">{scope}</p>
          {notice ? (
            <p className="explorer-notice" role="status">
              {notice}
            </p>
          ) : null}
        </section>
      </div>

      <section className={`panel explorer-moves-panel${fresh ? "" : " is-stale"}`} aria-label="Moves" aria-busy={loading}>
        {error ? (
          <div className="explorer-error">
            {line.moves.length && error.includes("never") ? (
              <>
                <h2>No game in these filters reached this position</h2>
                <p className="node-name-note">{error}</p>
              </>
            ) : (
              <p className="error-text">Could not load the tree: {error}</p>
            )}
            {line.moves.length ? (
              <div className="explorer-error-actions">
                <button className="secondary-button" type="button" onClick={back}>
                  Back one move
                </button>
                <button className="secondary-button" type="button" onClick={() => goTo([])}>
                  Start position
                </button>
              </div>
            ) : null}
          </div>
        ) : node ? (
          <MoveTable
            node={node}
            color={color}
            ply={ply}
            selected={Math.min(selected, Math.max(0, node.edges.length - 1))}
            onSelect={setSelected}
            onFollow={follow}
            onShowGames={showGames}
            weighted={weighted}
            maxPly={data?.maxPly ?? OPENING_PLY_LIMIT}
            repertoire={
              node.ownerToMove && ply <= REPERTOIRE_MAX_PLY
                ? { uci: repEntry?.uci ?? null, busy: repBusy || !fresh, onSet: setAsMyMove, alternativesHref: (edge) => alternativesHref(color, line.moves, edge.uci) }
                : undefined
            }
          />
        ) : (
          <p className="move-table-empty">{loading ? "Loading the tree…" : "No data."}</p>
        )}
      </section>

      {drawer ? <GamesDrawer tree={tree} move={drawer} onClose={closeDrawer} /> : null}
    </div>
  );
}
