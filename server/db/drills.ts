import type { CardContent, CardStatus, ConfirmState, DeepCheck, StoredCard } from "../../shared/training/cards.js";
import type { DrillKind, SrsState } from "../../shared/training/scheduler.js";
import type { DrillVerdict } from "../../shared/training/judge.js";
import type { PlayerColor } from "../../shared/types.js";
import type { Db } from "./connection.js";

// drill_cards (one row per card, keyed by kind|color|epd), drill_reviews (the append-only answer
// log) and drill_meta (the regeneration stamp).

interface CardRow {
  id: string;
  kind: DrillKind;
  color: PlayerColor;
  epd: string;
  status: CardStatus;
  confirm: ConfirmState;
  content_json: string;
  check_json: string | null;
  box: number;
  due_at: number | null;
  introduced_at: number | null;
  lapses: number;
  streak: number;
  reviews: number;
  last_review_at: number | null;
  retired: number;
  generated_at: number;
}

type Content = Omit<CardContent, "id" | "kind" | "color" | "epd">;

function fromRow(row: CardRow): StoredCard {
  const content = JSON.parse(row.content_json) as Content;
  return {
    id: row.id,
    kind: row.kind,
    color: row.color,
    epd: row.epd,
    ...content,
    status: row.status,
    confirm: row.confirm,
    check: row.check_json ? (JSON.parse(row.check_json) as DeepCheck) : null,
    srs: {
      box: row.box,
      dueAt: row.due_at,
      introducedAt: row.introduced_at,
      lapses: row.lapses,
      streak: row.streak,
      reviews: row.reviews,
      lastReviewAt: row.last_review_at,
      retired: row.retired === 1
    },
    generatedAt: row.generated_at
  };
}

function contentOf(card: CardContent): Content {
  const { ply, pathUci, pathSan, primary, lineName, eco, weight, sources } = card;
  return { ply, pathUci, pathSan, primary, lineName, eco, weight, sources };
}

const COLUMNS =
  "id, kind, color, epd, status, confirm, content_json, check_json, box, due_at, introduced_at, lapses, streak, reviews, last_review_at, retired, generated_at";

export function listCards(db: Db, username: string): StoredCard[] {
  return (db.prepare(`SELECT ${COLUMNS} FROM drill_cards WHERE username = ? ORDER BY id`).all(username) as CardRow[]).map(fromRow);
}

export function getCard(db: Db, username: string, id: string): StoredCard | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM drill_cards WHERE username = ? AND id = ?`).get(username, id) as CardRow | undefined;
  return row ? fromRow(row) : undefined;
}

/** Writes cards (insert or replace), in one transaction. */
export function putCards(db: Db, username: string, cards: readonly StoredCard[]): void {
  const statement = db.prepare(
    `INSERT INTO drill_cards (username, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (username, id) DO UPDATE SET
       status = excluded.status, confirm = excluded.confirm, content_json = excluded.content_json,
       check_json = excluded.check_json, box = excluded.box, due_at = excluded.due_at,
       introduced_at = excluded.introduced_at, lapses = excluded.lapses, streak = excluded.streak,
       reviews = excluded.reviews, last_review_at = excluded.last_review_at, retired = excluded.retired,
       generated_at = excluded.generated_at`
  );
  db.transaction(() => {
    for (const card of cards) {
      statement.run(
        username,
        card.id,
        card.kind,
        card.color,
        card.epd,
        card.status,
        card.confirm,
        JSON.stringify(contentOf(card)),
        card.check ? JSON.stringify(card.check) : null,
        card.srs.box,
        card.srs.dueAt,
        card.srs.introducedAt,
        card.srs.lapses,
        card.srs.streak,
        card.srs.reviews,
        card.srs.lastReviewAt,
        card.srs.retired ? 1 : 0,
        card.generatedAt
      );
    }
  })();
}

export function putSrs(db: Db, username: string, id: string, srs: SrsState): void {
  db.prepare(
    `UPDATE drill_cards SET box = ?, due_at = ?, introduced_at = ?, lapses = ?, streak = ?, reviews = ?, last_review_at = ?, retired = ?
     WHERE username = ? AND id = ?`
  ).run(srs.box, srs.dueAt, srs.introducedAt, srs.lapses, srs.streak, srs.reviews, srs.lastReviewAt, srs.retired ? 1 : 0, username, id);
}

export function putConfirm(db: Db, username: string, id: string, confirm: ConfirmState, check: DeepCheck | null): void {
  db.prepare("UPDATE drill_cards SET confirm = ?, check_json = ? WHERE username = ? AND id = ?").run(
    confirm,
    check ? JSON.stringify(check) : null,
    username,
    id
  );
}

export interface DrillReview {
  cardId: string;
  kind: DrillKind;
  reviewedAt: number;
  uci: string;
  san: string;
  verdict: DrillVerdict;
  loss: number | null;
  graded: boolean;
  attempts: number;
  ms: number | null;
  boxBefore: number;
  boxAfter: number;
  dueAfter: number | null;
}

export function insertReview(db: Db, username: string, review: DrillReview): void {
  db.prepare(
    `INSERT INTO drill_reviews (username, card_id, kind, reviewed_at, uci, san, verdict, loss, graded, attempts, ms, box_before, box_after, due_after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    username,
    review.cardId,
    review.kind,
    review.reviewedAt,
    review.uci,
    review.san,
    review.verdict,
    review.loss,
    review.graded ? 1 : 0,
    review.attempts,
    review.ms,
    review.boxBefore,
    review.boxAfter,
    review.dueAfter
  );
}

export function listReviews(db: Db, username: string, cardId?: string): DrillReview[] {
  const rows = (
    cardId
      ? db.prepare("SELECT * FROM drill_reviews WHERE username = ? AND card_id = ? ORDER BY id").all(username, cardId)
      : db.prepare("SELECT * FROM drill_reviews WHERE username = ? ORDER BY id").all(username)
  ) as Record<string, unknown>[];
  return rows.map((row) => ({
    cardId: row.card_id as string,
    kind: row.kind as DrillKind,
    reviewedAt: row.reviewed_at as number,
    uci: row.uci as string,
    san: row.san as string,
    verdict: row.verdict as DrillVerdict,
    loss: row.loss as number | null,
    graded: row.graded === 1,
    attempts: row.attempts as number,
    ms: row.ms as number | null,
    boxBefore: row.box_before as number,
    boxAfter: row.box_after as number,
    dueAfter: row.due_after as number | null
  }));
}

/** Graded reviews since `sinceMs`, by kind and outcome. */
export function countReviewsSince(db: Db, username: string, sinceMs: number): { kind: DrillKind; correct: number; wrong: number }[] {
  return db
    .prepare(
      `SELECT kind, SUM(CASE WHEN verdict = 'wrong' THEN 0 ELSE 1 END) AS correct, SUM(CASE WHEN verdict = 'wrong' THEN 1 ELSE 0 END) AS wrong
       FROM drill_reviews WHERE username = ? AND graded = 1 AND reviewed_at >= ? GROUP BY kind`
    )
    .all(username, sinceMs) as { kind: DrillKind; correct: number; wrong: number }[];
}

export function getMeta(db: Db, username: string, key: string): string | undefined {
  return (db.prepare("SELECT value FROM drill_meta WHERE username = ? AND key = ?").get(username, key) as { value: string } | undefined)?.value;
}

export function setMeta(db: Db, username: string, key: string, value: string): void {
  db.prepare("INSERT INTO drill_meta (username, key, value) VALUES (?, ?, ?) ON CONFLICT (username, key) DO UPDATE SET value = excluded.value").run(
    username,
    key,
    value
  );
}
