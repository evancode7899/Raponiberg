"use client";

import {
  ResponsiveContainer,
  type ResponsiveContainerProps,
} from "recharts";

/**
 * Recharts throttles ResizeObserver when debounce > 0 (`leading: false`), which can
 * leave charts at 0×0 or let a late zero-size callback win. Default matches Recharts (0).
 * Pass a positive debounce only if you need to throttle very chatty resizes.
 */
const DEFAULT_DEBOUNCE_MS = 0;

/**
 * Size used before the container is first measured. Recharts' own default (-1 × -1)
 * logs a "width(-1) and height(-1) of chart should be greater than 0" warning on every
 * chart's first render; the real size replaces this one as soon as it is measured.
 */
const INITIAL_DIMENSION = { width: 1, height: 1 };

export function RechartsResponsive({
  debounce = DEFAULT_DEBOUNCE_MS,
  children,
  ...rest
}: Omit<ResponsiveContainerProps, "width" | "height"> & {
  debounce?: number;
}) {
  return (
    <ResponsiveContainer
      width="100%"
      height="100%"
      debounce={debounce}
      initialDimension={INITIAL_DIMENSION}
      {...rest}
    >
      {children}
    </ResponsiveContainer>
  );
}
