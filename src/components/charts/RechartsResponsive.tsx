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
      {...rest}
    >
      {children}
    </ResponsiveContainer>
  );
}
