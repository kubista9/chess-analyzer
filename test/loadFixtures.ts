import fs from "node:fs";

// Raw game objects as returned by https://api.chess.com/pub/player/<user>/games/YYYY/MM.
export interface RawChessComPlayer {
  rating: number;
  result: string;
  "@id": string;
  username: string;
  uuid: string;
}

export interface RawChessComGame {
  url: string;
  pgn: string;
  time_control: string;
  end_time: number;
  rated: boolean;
  tcn?: string;
  uuid: string;
  initial_setup: string;
  fen: string;
  time_class: string;
  rules: string;
  eco?: string;
  white: RawChessComPlayer;
  black: RawChessComPlayer;
}

export interface RawArchiveMonth {
  games: RawChessComGame[];
}

function loadFixture(name: string): RawArchiveMonth {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as RawArchiveMonth;
}

/** 8 real games of the owner (kubista9), verbatim from the archive API. */
export function loadOwnerGames(): RawChessComGame[] {
  return loadFixture("owner-games.sample.json").games;
}

/** A synthetic 2026-09 archive month with the edge cases the importer must filter. */
export function loadArchiveSample(): RawArchiveMonth {
  return loadFixture("archive-sample.json");
}

export function gameId(game: RawChessComGame): string {
  return game.url.split("/").at(-1) ?? "";
}
