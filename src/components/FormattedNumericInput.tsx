"use client";

import {
  clampDecimal,
  clampInt,
  formatDecimalDisplay,
  formatIntegerDisplay,
  fractionDigitsForStep,
  parseDecimalInput,
  parseIntegerInput,
} from "@/lib/formatNumericInput";
import {
  useCallback,
  useEffect,
  useState,
  type InputHTMLAttributes,
} from "react";

type BaseProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type"
> & {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
};

export function FormattedIntegerInput({
  value,
  onChange,
  min,
  max,
  className,
  disabled,
  onFocus: onFocusProp,
  onBlur: onBlurProp,
  ...rest
}: BaseProps) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(() => formatIntegerDisplay(value));

  useEffect(() => {
    if (!focused) {
      setText(formatIntegerDisplay(value));
    }
  }, [value, focused]);

  const commit = useCallback(
    (raw: string) => {
      let n = parseIntegerInput(raw);
      n = clampInt(n, min, max);
      onChange(n);
      setText(formatIntegerDisplay(n));
    },
    [min, max, onChange],
  );

  return (
    <input
      {...rest}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      disabled={disabled}
      className={className}
      value={focused ? text : formatIntegerDisplay(value)}
      onFocus={(e) => {
        setFocused(true);
        setText(
          Number.isFinite(value) && value !== 0
            ? String(Math.trunc(value))
            : value === 0
              ? "0"
              : "",
        );
        onFocusProp?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        commit(text);
        onBlurProp?.(e);
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const n = clampInt(parseIntegerInput(raw), min, max);
        onChange(n);
      }}
    />
  );
}

export function FormattedDecimalInput({
  value,
  onChange,
  min,
  max,
  maxFractionDigits = 2,
  step,
  className,
  disabled,
  onFocus: onFocusProp,
  onBlur: onBlurProp,
  ...rest
}: BaseProps & {
  maxFractionDigits?: number;
  step?: number;
}) {
  const frac =
    step !== undefined ? fractionDigitsForStep(step) : maxFractionDigits;

  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(() => formatDecimalDisplay(value, frac));

  useEffect(() => {
    if (!focused) {
      setText(formatDecimalDisplay(value, frac));
    }
  }, [value, focused, frac]);

  const commit = useCallback(
    (raw: string) => {
      let n = parseDecimalInput(raw, frac);
      n = clampDecimal(n, min, max, frac);
      onChange(n);
      setText(formatDecimalDisplay(n, frac));
    },
    [frac, min, max, onChange],
  );

  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      disabled={disabled}
      className={className}
      value={focused ? text : formatDecimalDisplay(value, frac)}
      onFocus={(e) => {
        setFocused(true);
        const s = formatDecimalDisplay(value, frac).replace(/,/g, "");
        setText(s === "0" && value === 0 ? "0" : s);
        onFocusProp?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        commit(text);
        onBlurProp?.(e);
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        let n = parseDecimalInput(raw, frac);
        n = clampDecimal(n, min, max, frac);
        onChange(n);
      }}
    />
  );
}
