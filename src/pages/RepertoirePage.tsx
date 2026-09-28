import { Fragment, useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Chessboard } from "react-chessboard";
import type { Arrow } from "react-chessboard/dist/chessboard/types";
import { ChevronDown, ChevronRight, Compass, Download, Lock, LockOpen, RefreshCw, Star } from "lucide-react";
import type { ColorRepertoireView, RepNodeView } from "../../shared/repertoire";
import type { SeedChange } from "../../shared/repertoireSeed";
import { formatLine } from "../../shared/openingTree";
import type { PlayerColor, SeedResponse } from "../../shared/types";
import { fetchRepertoire, putRepEntry, repertoireExportHref, seedRepertoire, type RepEntryEdit, type RepertoireQuery } from "../api/client";
import { boardColors, boardTheme } from "../components/boardTheme";
import { FilterBar } from "../components/FilterBar";
import { explorerHref, scopeText } from "../components/FixCard";
import { moveLabel } from "../components/MoveTable";
import { RepChips } from "../components/RepTag";
import { useFilters } from "../hooks/useFilters";
import { useStoreQuery } from "../hooks/useStoreQuery";
import { useWorkspace } from "../hooks/useWorkspace";
import { formatCount, formatDay, pct } from "../utils/formatters";
import "../styles/explorer.css";
import "../styles/leaks.css";
import "../styles/repertoire.css";

const other = (color: PlayerColor): PlayerColor => (color === "white" ? "black" : "white");
const fenOf = (epd: string) => `${epd} 0 1`;
/** Rows open by default down to this ply. */
const OPEN_PLY = 5;

/** "through move 4" for ply 8. */
const throughMove = (ply: number) => `move ${ply / 2}`;

function Coverage({ view }: { view: ColorRepertoireView }) {
  if (!view.entries) {
    return <span className="cell-sub">no repertoire yet</span>;
  }
  return (
    <span className="rep-coverage">
      {view.coverage.map((coverage) => (
        <span key={coverage.ply} title={`${coverage.stayed} of ${coverage.games} games still followed the repertoire after ply ${coverage.ply}`}>
          through {throughMove(coverage.ply)}: <strong>{coverage.rate === null ? "–" : pct(coverage.rate)}</strong>
        </span>
      ))}
    </span>
  );
}

interface TreeProps {
  view: ColorRepertoireView;
  byEpd: Map<string, RepNodeView>;
  selected: string;
  onSelect: (epd: string) => void;
  open: Set<string>;
  onToggle: (epd: string) => void;
}

/** The owner's move at an owner node, as a clickable chip with its tags (or "no move yet"). */
function OwnerMove({ node, selected, onSelect }: { node: RepNodeView; selected: string; onSelect: (epd: string) => void }) {
  const entry = node.entry;
  return (
    <button
      type="button"
      className={`rep-own${selected === node.epd ? " is-selected" : ""}${entry ? "" : " rep-own-missing"}`}
      onClick={() => onSelect(node.epd)}
      aria-current={selected === node.epd ? "true" : undefined}
    >
      {entry ? (
        <>
          <span className="rep-san">{moveLabel(node.ply + 1, entry.san)}</span>
          <RepChips entry={entry} compact />
        </>
      ) : (
        <span className="rep-none">no move yet · {formatCount(node.n)} game{node.n === 1 ? "" : "s"}</span>
      )}
    </button>
  );
}

/**
 * The lines below an opponent node: one row per reply (the reply, then the owner's answer), with
 * the continuation nested under it. A transposed position links to where it is shown.
 */
function Replies({ node, depth, ...props }: TreeProps & { node: RepNodeView; depth: number }) {
  return (
    <ul className="rep-lines" role={depth === 0 ? "tree" : "group"}>
      {node.children.map((child) => {
        const target = props.byEpd.get(child.toEpd);
        const path = [...node.moves, child.uci].join(",");
        if (!target) {
          return null;
        }
        const transposed = target.moves.join(",") !== path;
        const next = target.entry ? props.byEpd.get(target.children[0]?.toEpd ?? "") : undefined;
        const expandable = !transposed && Boolean(next?.children.length);
        const isOpen = expandable && props.open.has(target.epd);
        return (
          <li key={child.uci} role="treeitem" aria-expanded={expandable ? isOpen : undefined}>
            <div className="rep-row">
              {expandable ? (
                <button type="button" className="rep-toggle" onClick={() => props.onToggle(target.epd)} aria-label={isOpen ? "Collapse" : "Expand"}>
                  {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
              ) : (
                <span className="rep-toggle-space" aria-hidden="true" />
              )}
              <span className="rep-opp" title={`${formatCount(child.n)} games · ${pct(child.share)} of the games here`}>
                {moveLabel(node.ply + 1, child.san)}
                <span className="cell-sub"> {formatCount(child.n)}</span>
              </span>
              {transposed ? (
                <button type="button" className="rep-transposed" onClick={() => props.onSelect(target.epd)}>
                  transposes to {formatLine(target.sans)}
                </button>
              ) : target.ownerToMove && target.ply < 16 ? (
                <OwnerMove node={target} selected={props.selected} onSelect={props.onSelect} />
              ) : null}
            </div>
            {isOpen && next ? <Replies node={next} depth={depth + 1} {...props} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function LinesTree(props: TreeProps) {
  const start = props.view.nodes[0];
  if (!start) {
    return null;
  }
  if (props.view.color === "black") {
    return <Replies node={start} depth={0} {...props} />;
  }
  // White: the first move, then the replies to it.
  const after = start.entry ? props.byEpd.get(start.children[0]?.toEpd ?? "") : undefined;
  return (
    <div className="rep-lines-root">
      <div className="rep-row">
        <span className="rep-toggle-space" aria-hidden="true" />
        <OwnerMove node={start} selected={props.selected} onSelect={props.onSelect} />
      </div>
      {after ? <Replies node={after} depth={0} {...props} /> : null}
    </div>
  );
}

/** The selected owner position: board, the entry and why, and the moves to choose from. */
function NodePanel({
  node,
  color,
  busy,
  onEdit
}: {
  node: RepNodeView;
  color: PlayerColor;
  busy: boolean;
  onEdit: (edit: Omit<RepEntryEdit, "color" | "epd">) => void;
}) {
  const entry = node.entry;
  const ply = node.ply + 1;
  const arrows: Arrow[] = entry ? [[entry.uci.slice(0, 2), entry.uci.slice(2, 4), boardColors.arrow] as Arrow] : [];
  return (
    <div className="rep-panel">
      <div className="rep-board">
        <Chessboard id="repertoire-board" position={fenOf(node.epd)} boardOrientation={color} arePiecesDraggable={false} customArrows={arrows} {...boardTheme} />
      </div>
      <p className="rep-panel-line">{node.sans.length ? formatLine(node.sans) : "Start position"}</p>
      {node.name ? (
        <p className="node-name-note">
          <span className="eco-badge">{node.eco}</span> {node.name}
        </p>
      ) : null}

      {entry ? (
        <div className="rep-entry">
          <h3>
            Your move: {moveLabel(ply, entry.san)} <RepChips entry={entry} />
          </h3>
          {entry.replaced ? (
            <p className="rep-why">
              Replaces {moveLabel(ply, entry.replaced.san)}
              {entry.replaced.loss !== null ? ` (engine loss ${entry.replaced.loss.toFixed(1)})` : ""}: {entry.replaced.reason}
            </p>
          ) : null}
          {entry.reason ? <p className="rep-why">{entry.reason}</p> : null}
          {node.entryStats ? (
            <p className="cell-sub">
              {formatCount(node.entryStats.n)} of your games here
              {node.entryStats.score !== null ? ` · ${pct(node.entryStats.score)}` : ""}
              {node.entryStats.loss !== null ? ` · engine loss ${node.entryStats.loss.toFixed(1)}` : " · not engine-checked yet"}
            </p>
          ) : null}
          <div className="rep-actions">
            {entry.status === "needs-review" ? (
              <button type="button" className="primary-button" disabled={busy} onClick={() => onEdit({ status: "active", locked: true })}>
                Accept
              </button>
            ) : null}
            <button type="button" className="secondary-button" disabled={busy} onClick={() => onEdit({ locked: !entry.locked })}>
              {entry.locked ? <LockOpen size={15} aria-hidden="true" /> : <Lock size={15} aria-hidden="true" />}
              {entry.locked ? "Unlock" : "Lock"}
            </button>
            <Link className="secondary-button" to={explorerHref(color, node.moves)}>
              <Compass size={15} aria-hidden="true" /> Explorer
            </Link>
          </div>
        </div>
      ) : (
        <p className="rep-why">
          No repertoire move here yet ({formatCount(node.n)} game{node.n === 1 ? "" : "s"} reached it). Pick one below.
        </p>
      )}

      {node.options.length ? (
        <table className="rep-options">
          <caption>{entry ? "Change your move" : "Choose your move"}</caption>
          <thead>
            <tr>
              <th scope="col">Move</th>
              <th scope="col" title="Your games with it here and your score">
                Games
              </th>
              <th scope="col" title="Win% it gives away against the engine's best move">
                Loss
              </th>
              <th scope="col">
                <span className="visually-hidden">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {node.options.map((option) => (
              <tr key={option.uci} className={entry?.uci === option.uci ? "is-current" : undefined}>
                <th scope="row">
                  {moveLabel(ply, option.san)}
                  {option.engineBest ? <Star className="engine-star" size={13} aria-label="The engine's best move" /> : null}
                </th>
                <td>{option.n ? `${formatCount(option.n)} · ${pct(option.score ?? 0)}` : <span className="cell-sub">engine idea</span>}</td>
                <td>{option.loss === null ? <span className="cell-sub">–</span> : option.loss.toFixed(1)}</td>
                <td>
                  {entry?.uci === option.uci ? (
                    <span className="cell-sub">current</span>
                  ) : (
                    <button type="button" className="rep-set" disabled={busy} onClick={() => onEdit({ uci: option.uci, ply })}>
                      Set as my move
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

/** Suggested changes first; entries chosen on results alone (no engine data yet) folded below. */
function ReviewQueue({ view, onSelect }: { view: ColorRepertoireView; onSelect: (epd: string) => void }) {
  const byEpd = new Map(view.nodes.map((node) => [node.epd, node]));
  const pending = view.nodes.filter((node) => node.entry?.status === "needs-review");
  const suggested = pending.filter((node) => node.entry!.replaced);
  const resultsOnly = pending.filter((node) => !node.entry!.replaced);
  const row = (node: RepNodeView) => (
    <li key={node.epd}>
      <button type="button" className="rep-queue-item" onClick={() => onSelect(node.epd)}>
        <span className="rep-queue-line">
          {node.sans.length ? `${formatLine(node.sans)} ` : ""}
          <strong>{moveLabel(node.ply + 1, node.entry!.san)}</strong>
        </span>
        <span className="rep-queue-why">{node.entry!.replaced?.reason ?? node.entry!.reason}</span>
      </button>
    </li>
  );
  if (!pending.length) {
    return <p className="home-empty">Nothing to review{view.entries ? "." : ": seed the repertoire first."}</p>;
  }
  return (
    <>
      {suggested.length ? (
        <>
          <h3 className="rep-subhead">Suggested changes · {suggested.length}</h3>
          <ul className="rep-queue">{suggested.map(row)}</ul>
        </>
      ) : null}
      {resultsOnly.length ? (
        <details className="rep-queue-more">
          <summary>
            {resultsOnly.length} chosen on your results only, until the engine checks them
          </summary>
          <ul className="rep-queue">{resultsOnly.slice(0, 60).map(row)}</ul>
          {resultsOnly.length > 60 ? <p className="cell-sub">… and {resultsOnly.length - 60} more.</p> : null}
        </details>
      ) : null}
      {byEpd.size && view.offTree.length ? (
        <p className="cell-sub">{view.offTree.length} entries are no longer reached from the start (an earlier move changed).</p>
      ) : null}
    </>
  );
}

function SeedPreview({ preview, busy, onApply, onClose }: { preview: SeedResponse; busy: boolean; onApply: () => void; onClose: () => void }) {
  const changes = [...preview.diff.white.changes, ...preview.diff.black.changes];
  const count = (kind: SeedChange["kind"]) => changes.filter((change) => change.kind === kind).length;
  const kept = preview.diff.white.kept + preview.diff.black.kept;
  const visible = changes.filter((change) => change.kind !== "update");
  const label = (change: SeedChange) =>
    change.line ?? `${change.color === "white" ? "White" : "Black"}, ply ${change.ply}: ${change.before ? moveLabel(change.ply, change.before.san) : ""}`;
  return (
    <section className="panel home-card rep-seed" aria-label="Seed preview">
      <div className="home-card-head">
        <h2>{preview.applied ? "Seed applied" : "Seed preview"}</h2>
      </div>
      <p>
        {count("add")} new · {count("change")} changed · {count("remove")} removed · {count("update")} with new notes · {kept} locked or edited
        kept as they are.
      </p>
      {visible.length ? (
        <ul className="rep-diff">
          {visible.slice(0, 40).map((change) => (
            <li key={`${change.color}|${change.epd}`} className={`rep-diff-${change.kind}`}>
              <span className="rep-diff-kind">{change.kind}</span> <span className={`mover-dot mover-dot-${change.color}`} aria-hidden="true" />{" "}
              {label(change)}
              {change.kind === "change" && change.before ? <span className="cell-sub"> (was {moveLabel(change.ply, change.before.san)})</span> : null}
              {change.after?.status === "needs-review" ? <span className="rep-chip rep-chip-review">needs review</span> : null}
            </li>
          ))}
          {visible.length > 40 ? <li className="cell-sub">… and {visible.length - 40} more</li> : null}
        </ul>
      ) : null}
      <div className="rep-actions">
        {!preview.applied && changes.length ? (
          <button type="button" className="primary-button" disabled={busy} onClick={onApply}>
            Apply {changes.length} change{changes.length === 1 ? "" : "s"}
          </button>
        ) : null}
        <button type="button" className="secondary-button" onClick={onClose}>
          {preview.applied || !changes.length ? "Close" : "Cancel"}
        </button>
      </div>
    </section>
  );
}

/** /repertoire: the owner's written repertoire per colour, seeded from his games and edited by him. */
export function RepertoirePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const color: PlayerColor = searchParams.get("color") === "black" ? "black" : "white";
  const [filters, setFilters] = useFilters();
  const { dataVersion } = useWorkspace();
  const query = useMemo<RepertoireQuery>(
    () => ({ window: filters.window, timeClass: filters.timeClass ?? undefined, weighted: filters.weighted }),
    [filters.window, filters.timeClass, filters.weighted]
  );
  const [version, setVersion] = useState(0);
  const { data, error, loading } = useStoreQuery((signal) => fetchRepertoire(query, signal), [query, dataVersion, version]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<SeedResponse | null>(null);
  const [selectedByColor, setSelectedByColor] = useState<Record<PlayerColor, string | null>>({ white: null, black: null });
  const [openByColor, setOpenByColor] = useState<Record<PlayerColor, Set<string> | null>>({ white: null, black: null });

  const view = data?.[color] ?? null;
  const byEpd = useMemo(() => new Map((view?.nodes ?? []).map((node) => [node.epd, node])), [view]);
  const firstOwner = view?.nodes.find((node) => node.ownerToMove)?.epd ?? null;
  const selected = selectedByColor[color] && byEpd.has(selectedByColor[color]!) ? selectedByColor[color]! : firstOwner;
  const selectedNode = selected ? byEpd.get(selected) : undefined;

  // Open down to OPEN_PLY, plus the path to the selected position.
  const open = useMemo(() => {
    const base = openByColor[color] ?? new Set((view?.nodes ?? []).filter((node) => node.ply < OPEN_PLY).map((node) => node.epd));
    return base;
  }, [openByColor, color, view]);

  const select = useCallback(
    (epd: string) => {
      setSelectedByColor((current) => ({ ...current, [color]: epd }));
      const node = byEpd.get(epd);
      if (node) {
        // Open every node on its path so the row is visible.
        setOpenByColor((current) => {
          const next = new Set(current[color] ?? open);
          const path: string[] = [];
          let at = view?.nodes[0];
          for (const uci of node.moves) {
            const child = at?.children.find((candidate) => candidate.uci === uci);
            at = child ? byEpd.get(child.toEpd) : undefined;
            if (at) {
              path.push(at.epd);
            }
          }
          path.forEach((key) => next.add(key));
          return { ...current, [color]: next };
        });
      }
    },
    [byEpd, color, open, view]
  );

  const toggle = useCallback(
    (epd: string) =>
      setOpenByColor((current) => {
        const next = new Set(current[color] ?? open);
        if (next.has(epd)) {
          next.delete(epd);
        } else {
          next.add(epd);
        }
        return { ...current, [color]: next };
      }),
    [color, open]
  );

  const edit = useCallback(
    async (node: RepNodeView, change: Omit<RepEntryEdit, "color" | "epd">) => {
      setBusy(true);
      try {
        const { entry } = await putRepEntry({ color, epd: node.epd, ...change });
        setNotice(
          change.uci
            ? `${moveLabel(node.ply + 1, entry.san)} is now your move here (locked).`
            : change.status === "active"
              ? `${moveLabel(node.ply + 1, entry.san)} accepted and locked.`
              : entry.locked
                ? "Locked: a re-seed will not change it."
                : "Unlocked: a re-seed may change it."
        );
        setVersion((value) => value + 1);
      } catch (caught) {
        setNotice(`Could not save: ${caught instanceof Error ? caught.message : String(caught)}`);
      } finally {
        setBusy(false);
      }
    },
    [color]
  );

  const runSeed = useCallback(
    async (apply: boolean) => {
      setBusy(true);
      try {
        const result = await seedRepertoire(query, apply);
        setPreview(result);
        if (apply) {
          setVersion((value) => value + 1);
        }
      } catch (caught) {
        setNotice(`Could not seed: ${caught instanceof Error ? caught.message : String(caught)}`);
      } finally {
        setBusy(false);
      }
    },
    [query]
  );

  const empty = data ? data.white.entries + data.black.entries === 0 : false;

  return (
    <div className="page-content repertoire-page">
      <section className="page-header">
        <div>
          <span className="eyebrow">Your moves, written down</span>
          <h1>Repertoire</h1>
          <p>
            One move for each position where it is your turn, up to move 8, seeded from the moves you play most that the engine
            accepts. Suggestions replace engine holes and lines that keep losing; you can accept, lock or change every move.
          </p>
        </div>
      </section>

      <FilterBar
        color={color}
        onColorChange={(next) =>
          setSearchParams((params) => {
            const updated = new URLSearchParams(params);
            updated.set("color", next);
            return updated;
          })
        }
        filters={filters}
        onFiltersChange={setFilters}
      />
      {data ? <p className="explorer-scope">{scopeText(filters, data.halfLifeDays)} · coverage and tables use these games</p> : null}

      <section className={`panel home-card rep-summary${loading && data ? " is-stale" : ""}`} aria-label="Summary" aria-busy={loading}>
        {error ? <p className="error-text">Could not load the repertoire: {error}</p> : null}
        {data ? (
          <div className="rep-summary-grid">
            {(["white", "black"] as const).map((side) => (
              <div key={side} className={`rep-summary-side${side === color ? " is-current" : ""}`}>
                <span className="fix-color">
                  <span className={`mover-dot mover-dot-${side}`} aria-hidden="true" />
                  As {side === "white" ? "White" : "Black"}
                </span>
                <span>
                  {formatCount(data[side].entries)} moves · {formatCount(data[side].needsReview)} to review
                </span>
                <Coverage view={data[side]} />
                <a className="rep-export" href={repertoireExportHref(side, query)} download>
                  <Download size={14} aria-hidden="true" /> PGN
                </a>
              </div>
            ))}
          </div>
        ) : !error ? (
          <p className="home-empty">Loading…</p>
        ) : null}
        <div className="rep-actions">
          <button type="button" className={empty ? "primary-button" : "secondary-button"} disabled={busy} onClick={() => runSeed(false)}>
            <RefreshCw size={15} aria-hidden="true" /> {empty ? "Seed from my games" : "Re-seed from my games"}
          </button>
          <span className="cell-sub">Shows the changes first. Locked and edited moves are never changed.</span>
        </div>
        {!data?.engine && data ? <p className="cell-sub">No engine: moves are chosen on results only and marked for review.</p> : null}
        {notice ? (
          <p className="explorer-notice" role="status">
            {notice}
          </p>
        ) : null}
      </section>

      {preview ? <SeedPreview preview={preview} busy={busy} onApply={() => runSeed(true)} onClose={() => setPreview(null)} /> : null}

      {view ? (
        <div className="rep-grid">
          <section className="panel home-card rep-tree-panel" aria-label="Lines">
            <div className="home-card-head">
              <h2>Lines as {color === "white" ? "White" : "Black"}</h2>
              <div className="rep-tree-tools">
                <button type="button" className="secondary-button" onClick={() => setOpenByColor((current) => ({ ...current, [color]: new Set(view.nodes.map((node) => node.epd)) }))}>
                  Expand all
                </button>
                <button type="button" className="secondary-button" onClick={() => setOpenByColor((current) => ({ ...current, [color]: new Set() }))}>
                  Collapse
                </button>
              </div>
            </div>
            <p className="cell-sub">
              {color === "white" ? "Your move, then" : ""} {other(color) === "white" ? "White's" : "Black's"} replies with 2+ games, most played first; the
              number is games.
            </p>
            <LinesTree view={view} byEpd={byEpd} selected={selected ?? ""} onSelect={select} open={open} onToggle={toggle} />
          </section>

          <section className="panel home-card rep-side" aria-label="Position">
            {selectedNode ? (
              <NodePanel node={selectedNode} color={color} busy={busy} onEdit={(change) => edit(selectedNode, change)} />
            ) : (
              <p className="home-empty">Select a move.</p>
            )}
          </section>
        </div>
      ) : null}

      {view ? (
        <section className="panel home-card" aria-label="Needs review">
          <div className="home-card-head">
            <h2>Needs review · {formatCount(view.needsReview)}</h2>
          </div>
          <ReviewQueue view={view} onSelect={select} />
        </section>
      ) : null}

      {view && view.entries ? (
        <div className="rep-tables">
          <section className="panel home-card" aria-label="Where you leave the repertoire">
            <h2>Where you leave it</h2>
            <p className="cell-sub">Your games that played another move than the repertoire, most frequent first.</p>
            {view.deviations.length ? (
              <table className="rep-table">
                <thead>
                  <tr>
                    <th scope="col">Position</th>
                    <th scope="col">You played</th>
                    <th scope="col">Repertoire</th>
                    <th scope="col">Games</th>
                    <th scope="col">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {view.deviations.map((row) => {
                    const node = byEpd.get(row.epd);
                    return (
                      <tr key={`${row.epd}|${row.played.uci}`}>
                        <td>
                          {node ? (
                            <button type="button" className="rep-link" onClick={() => select(row.epd)}>
                              {formatLine(node.sans) || "Start"}
                            </button>
                          ) : (
                            `ply ${row.ply}`
                          )}
                        </td>
                        <td>{moveLabel(row.ply, row.played.san)}</td>
                        <td>{moveLabel(row.ply, row.expected.san)}</td>
                        <td>{formatCount(row.n)}</td>
                        <td>
                          {pct(row.score)}{" "}
                          {row.examples[0] ? (
                            <Link className="cell-sub" to={`/review/${row.examples[0].id}?ply=${row.examples[0].ply}`} title="Review a game">
                              {formatDay(row.examples[0].endTime)}
                            </Link>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="home-empty">Every game follows the repertoire.</p>
            )}
          </section>

          <section className="panel home-card" aria-label="Unprepared replies">
            <h2>Not prepared</h2>
            <p className="cell-sub">Opponent replies after which the repertoire has no move, most frequent first.</p>
            {view.unprepared.length ? (
              <table className="rep-table">
                <thead>
                  <tr>
                    <th scope="col">After</th>
                    <th scope="col">Reply</th>
                    <th scope="col">Games</th>
                    <th scope="col">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {view.unprepared.map((row) => {
                    const parent = byEpd.get(row.parentEpd);
                    return (
                      <tr key={`${row.parentEpd}|${row.opp.uci}`}>
                        <td>{parent ? formatLine(parent.sans) || "Start" : `ply ${row.ply - 1}`}</td>
                        <td>
                          {byEpd.has(row.epd) ? (
                            <button type="button" className="rep-link" onClick={() => select(row.epd)}>
                              {moveLabel(row.ply, row.opp.san)}
                            </button>
                          ) : (
                            <Fragment>
                              {parent ? (
                                <Link to={explorerHref(color, [...parent.moves, row.opp.uci])}>{moveLabel(row.ply, row.opp.san)}</Link>
                              ) : (
                                moveLabel(row.ply, row.opp.san)
                              )}
                            </Fragment>
                          )}
                        </td>
                        <td>{formatCount(row.n)}</td>
                        <td>{pct(row.score)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="home-empty">No unprepared replies.</p>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
