import { useEffect, useState, type RefObject } from "react";

/** The smallest board drawn: react-chessboard v4 misdraws below this. */
export const MIN_BOARD_WIDTH = 200;

/**
 * The board size that fits its wrapper: the wrapper's width, capped at `maxWidth` and at the
 * viewport height minus room for the chrome, never below MIN_BOARD_WIDTH. Re-measured with a
 * ResizeObserver; 0 until the first measurement.
 */
export function useBoardWidth(ref: RefObject<HTMLElement | null>, maxWidth: number): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = () => {
      const available = element.clientWidth;
      const byHeight = window.innerHeight - (window.innerWidth < 1024 ? 230 : 170);
      const next = Math.floor(Math.max(MIN_BOARD_WIDTH, Math.min(available, maxWidth, Math.max(byHeight, 280))));
      setWidth((current) => (Math.abs(current - next) >= 1 ? next : current));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref, maxWidth]);

  return width;
}
