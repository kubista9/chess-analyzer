import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useWorkspace } from "../hooks/useWorkspace";

interface OpeningPreview {
  title: string;
  moves: string[];
  fen: string;
  idea: string;
}

const previewLines: Array<{
  match: string[];
  title: string;
  moves: string[];
  idea: string;
}> = [
  {
    match: ["english"],
    title: "English Opening",
    moves: ["c4", "e5", "Nc3", "Nf6", "g3", "d5", "cxd5", "Nxd5", "Bg2"],
    idea: "White fights for the d5 square from the flank and often builds pressure with Bg2."
  },
  {
    match: ["giuoco", "italian"],
    title: "Giuoco Piano",
    moves: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6", "d3"],
    idea: "Both sides develop naturally; White prepares d4 while keeping the king safe."
  },
  {
    match: ["king pawn", "kings pawn", "king's pawn"],
    title: "King's Pawn Opening",
    moves: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6"],
    idea: "Open central files make development speed and king safety matter immediately."
  },
  {
    match: ["bishop"],
    title: "Bishop's Opening",
    moves: ["e4", "e5", "Bc4", "Nf6", "d3", "Bc5", "Nf3"],
    idea: "White develops the bishop before the knight and keeps several center structures available."
  },
  {
    match: ["sicilian"],
    title: "Sicilian Defense",
    moves: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3"],
    idea: "Black trades a flank pawn for central counterplay and an unbalanced middlegame."
  },
  {
    match: ["french"],
    title: "French Defense",
    moves: ["e4", "e6", "d4", "d5", "Nc3", "Nf6", "e5"],
    idea: "The locked center creates pawn-chain plans and pressure around d4 and e5."
  },
  {
    match: ["caro"],
    title: "Caro-Kann Defense",
    moves: ["e4", "c6", "d4", "d5", "Nc3", "dxe4", "Nxe4", "Bf5"],
    idea: "Black supports d5 with c6 and aims for a sturdy structure with active light-square play."
  },
  {
    match: ["queen pawn", "queens pawn", "queen's pawn"],
    title: "Queen's Pawn Opening",
    moves: ["d4", "d5", "c4", "e6", "Nc3", "Nf6", "Nf3"],
    idea: "White builds central space and usually plays for c-file pressure or a later e4 break."
  },
  {
    match: ["london"],
    title: "London System",
    moves: ["d4", "d5", "Nf3", "Nf6", "Bf4", "e6", "e3"],
    idea: "White develops the dark-square bishop early and reaches a repeatable attacking setup."
  },
  {
    match: ["indian", "king indian", "king's indian"],
    title: "King's Indian Setup",
    moves: ["d4", "Nf6", "c4", "g6", "Nc3", "Bg7", "e4", "d6"],
    idea: "Black lets White take space, then challenges the center with piece pressure and pawn breaks."
  },
  {
    match: ["reti", "reti"],
    title: "Reti Opening",
    moves: ["Nf3", "d5", "c4", "e6", "g3", "Nf6", "Bg2"],
    idea: "White delays the central pawn commitment and attacks the center from the flank."
  },
  {
    match: ["ruy", "spanish"],
    title: "Ruy Lopez",
    moves: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6"],
    idea: "White pressures the e5 pawn and builds long-term kingside and central pressure."
  },
  {
    match: ["scandinavian"],
    title: "Scandinavian Defense",
    moves: ["e4", "d5", "exd5", "Qxd5", "Nc3", "Qa5", "d4"],
    idea: "Black challenges e4 immediately, then accepts early queen activity."
  }
];

function normalizeOpeningName(value: string): string {
  return value.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function buildFen(moves: string[]): string {
  const chess = new Chess();

  for (const move of moves) {
    const result = (() => {
      try {
        return chess.move(move);
      } catch {
        return null;
      }
    })();

    if (!result) {
      break;
    }
  }

  return chess.fen();
}

function openingPreviewFor(openingFamily: string): OpeningPreview {
  const normalized = normalizeOpeningName(openingFamily);
  const line = previewLines.find((preview) =>
    preview.match.some((match) => normalized.includes(normalizeOpeningName(match)))
  ) ?? {
    title: openingFamily,
    moves: ["e4", "e5", "Nf3", "Nc6"],
    idea: "A representative open-game structure. Use the report metrics to decide whether this family needs repair."
  };

  return {
    title: line.title,
    moves: line.moves,
    fen: buildFen(line.moves),
    idea: line.idea
  };
}

export function OpeningReportPage() {
  const { snapshot } = useWorkspace();

  return (
    <div className="page-content">
      <section className="page-header">
        <div>
          <h1>Opening Report</h1>
        </div>
      </section>

      {!snapshot ? (
        <section className="panel empty-panel">
          <h2>No opening report yet</h2>
          <p>Run a bulk analysis and this page will group your openings by frequency, quality, and repair priority.</p>
        </section>
      ) : (
        <section className="panel">
          <div className="list-panel">
            {snapshot.topOpenings.map((opening) => {
              const preview = openingPreviewFor(opening.openingFamily);

              return (
                <article
                  className="opening-card"
                  key={opening.openingFamily}
                  tabIndex={0}
                >
                  <div className="opening-card-header">
                    <div>
                      <h2>{opening.openingFamily}</h2>
                      <p>{opening.games} games in sample</p>
                    </div>
                    <div className="opening-pill">{opening.winRate.toFixed(0)}% win rate</div>
                  </div>

                  <div className="opening-stats">
                    <div>
                      <span>Avg accuracy</span>
                      <strong>{opening.avgAccuracy?.toFixed(1) ?? "—"}%</strong>
                    </div>
                    <div>
                      <span>Avg blunders</span>
                      <strong>{opening.avgBlunders.toFixed(2)}</strong>
                    </div>
                    <div>
                      <span>First major error</span>
                      <strong>{opening.avgFirstErrorPly?.toFixed(0) ?? "—"} ply</strong>
                    </div>
                  </div>

                  <p className="opening-recommendation">{opening.recommendation}</p>

                  <aside className="opening-preview" aria-label={`${preview.title} preview`}>
                    <div className="opening-preview-copy">
                      <span className="eyebrow">Position preview</span>
                      <h3>{preview.title}</h3>
                      <p>{preview.idea}</p>
                      <div className="opening-preview-line">{preview.moves.join(" ")}</div>
                    </div>
                    <div className="opening-preview-board">
                      <Chessboard
                        id={`opening-preview-${normalizeOpeningName(opening.openingFamily).replace(/\s+/g, "-")}`}
                        position={preview.fen}
                        boardWidth={210}
                        arePiecesDraggable={false}
                        areArrowsAllowed={false}
                        showBoardNotation={false}
                        customDarkSquareStyle={{ backgroundColor: "#779954" }}
                        customLightSquareStyle={{ backgroundColor: "#eeeed2" }}
                        customBoardStyle={{
                          borderRadius: "14px",
                          overflow: "hidden",
                          boxShadow: "0 18px 34px rgba(0, 0, 0, 0.34)"
                        }}
                      />
                    </div>
                  </aside>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
