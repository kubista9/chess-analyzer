import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import type { OpeningReportItem, PlayerColor } from "../../shared/types";
import { useWorkspace } from "../hooks/useWorkspace";

interface OpeningPreview {
  title: string;
  moves: string[];
  fen: string;
  idea: string;
}

const OPENING_PREVIEW_BOARD_WIDTH = 190;

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
    match: ["reti"],
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

// Strips accents first, so "Réti" and "Reti" both normalise to "reti".
function normalizeOpeningName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
    idea: "A representative open-game structure; no dedicated preview line exists for this family yet."
  };

  return {
    title: line.title,
    moves: line.moves,
    fen: buildFen(line.moves),
    idea: line.idea
  };
}

const colorSections: Array<{ color: PlayerColor; title: string }> = [
  { color: "white", title: "As White" },
  { color: "black", title: "As Black" }
];

function OpeningCard({ opening }: { opening: OpeningReportItem }) {
  const preview = openingPreviewFor(opening.openingFamily);
  const cardKey = `${opening.color}-${normalizeOpeningName(opening.openingFamily).replace(/\s+/g, "-")}`;

  return (
    <article className="opening-card">
      <div className="opening-card-header">
        <div>
          <h2>{opening.openingFamily}</h2>
          <p>
            {opening.games} game{opening.games === 1 ? "" : "s"} in sample
          </p>
        </div>
        <div className="opening-pill">{opening.scorePct.toFixed(0)}% score</div>
      </div>

      <div className="opening-stats">
        <div>
          <span>Wins</span>
          <strong>{opening.wins}</strong>
        </div>
        <div>
          <span>Draws</span>
          <strong>{opening.draws}</strong>
        </div>
        <div>
          <span>Losses</span>
          <strong>{opening.losses}</strong>
        </div>
      </div>

      <aside className="opening-preview" aria-label={`${preview.title} preview`}>
        <div className="opening-preview-copy">
          <span className="eyebrow">Position preview</span>
          <h3>{preview.title}</h3>
          <p>{preview.idea}</p>
          <div className="opening-preview-line">{preview.moves.join(" ")}</div>
        </div>
        <div className="opening-preview-board">
          <Chessboard
            id={`opening-preview-${cardKey}`}
            position={preview.fen}
            boardWidth={OPENING_PREVIEW_BOARD_WIDTH}
            boardOrientation={opening.color}
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
}

export function OpeningReportPage() {
  const { snapshot } = useWorkspace();

  return (
    <div className="page-content">
      <section className="page-header">
        <div>
          <h1>Opening Report</h1>
          <p>Results by opening family, split by your colour. Score counts a win as 1 and a draw as 0.5.</p>
        </div>
      </section>

      {!snapshot ? (
        <section className="panel empty-panel">
          <h2>No opening report yet</h2>
          <p>Load your recent games from Home and this page will group them by colour and opening family.</p>
        </section>
      ) : (
        colorSections.map(({ color, title }) => {
          const openings = snapshot.topOpenings.filter((opening) => opening.color === color);

          return (
            <section className="panel opening-section" key={color} aria-label={title}>
              <h2 className="opening-section-title">{title}</h2>
              {openings.length ? (
                <div className="list-panel">
                  {openings.map((opening) => (
                    <OpeningCard key={`${opening.color}-${opening.openingFamily}`} opening={opening} />
                  ))}
                </div>
              ) : (
                <p className="opening-section-empty">No games as {color} in this sample.</p>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
