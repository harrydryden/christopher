/**
 * The Christopher mark: one drum of the Bombe as a 16×16 pixel wheel, its dial
 * opening the ring into a "C". Cells are `x,y` pairs on a 0–15 axis.
 *
 * This is the single source for the artwork. `Mark.tsx` renders it in the app
 * and `scripts/generate-brand-assets.ts` renders the favicons and PNGs from it,
 * so the tab icon and the mark on the page can never drift apart.
 */
export const MARK_CELLS =
  "5,0 6,0 7,0 8,0 9,0 10,0 3,1 4,1 5,1 6,1 7,1 8,1 9,1 10,1 11,1 12,1 2,2 3,2 4,2 5,2 10,2 11,2 12,2 13,2 1,3 2,3 3,3 12,3 13,3 14,3 1,4 2,4 13,4 14,4 0,5 1,5 2,5 13,5 14,5 15,5 0,6 1,6 14,6 15,6 0,7 1,7 0,8 1,8 0,9 1,9 14,9 15,9 0,10 1,10 2,10 13,10 14,10 15,10 1,11 2,11 13,11 14,11 1,12 2,12 3,12 12,12 13,12 14,12 2,13 3,13 4,13 5,13 10,13 11,13 12,13 13,13 3,14 4,14 5,14 6,14 7,14 8,14 9,14 10,14 11,14 12,14 5,15 6,15 7,15 8,15 9,15 10,15 6,6 7,6 8,6 9,6 6,7 9,7 6,8 9,8 6,9 7,9 8,9 9,9 10,6 10,9 11,6 11,9 12,6 12,9 13,6 13,9 7,3 8,3 7,12 8,12 3,7 3,8"
    .split(" ")
    .map((cell) => {
      const [x, y] = cell.split(",").map(Number);
      return { x: x!, y: y! };
    });

/** The mark is drawn on a 16-cell grid and renders at whole multiples of it. */
export const MARK_GRID = 16;
