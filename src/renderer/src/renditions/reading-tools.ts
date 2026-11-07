import type { ReadingLocationV1 } from "../../../shared/contracts.js";

export type ReaderSelection = {
  text: string;
  location: ReadingLocationV1;
  endLocation?: ReadingLocationV1;
  rect: { x: number; y: number; width: number; height: number };
};

export type ReaderSearchResult = {
  id: string;
  text: string;
  location: ReadingLocationV1;
  endLocation?: ReadingLocationV1;
};

export type ReaderMark = {
  id: string;
  location: ReadingLocationV1;
  endLocation?: ReadingLocationV1;
  color: "cyan" | "yellow" | "pink";
};
