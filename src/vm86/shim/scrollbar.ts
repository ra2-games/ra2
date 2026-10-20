/** Native ScrollBar logical ranges and pixel geometry; position includes nMax, with page size consuming the trailing range. */
export interface ScrollbarState {
  min: number;
  max: number;
  page: number;
  pos: number;
  trackPos: number;
  disabled: number;
}

export function scrollbarLimit(state: ScrollbarState): number {
  return Math.max(state.min, state.max - Math.max(0, state.page - 1));
}

export function clampScrollbar(state: ScrollbarState): void {
  state.max = Math.max(state.min, state.max);
  state.page = Math.min(state.page, state.max - state.min + 1);
  state.pos = Math.max(state.min, Math.min(scrollbarLimit(state), state.pos));
  state.trackPos = Math.max(state.min, Math.min(scrollbarLimit(state), state.trackPos));
}

export function scrollbarGeometry(state: ScrollbarState, length: number, breadth: number) {
  const arrow = Math.min(breadth, Math.floor(length / 2));
  const track = Math.max(0, length - arrow * 2);
  const thumb = Math.min(
    track,
    Math.max(8, state.page ? Math.floor((track * state.page) / (state.max - state.min + 1)) : breadth),
  );
  const travel = track - thumb;
  const range = scrollbarLimit(state) - state.min;
  const start = arrow + (range > 0 ? Math.round((travel * (state.pos - state.min)) / range) : 0);
  return { arrow, thumb, travel, start };
}
