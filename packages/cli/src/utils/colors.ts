/**
 * ANSI color utilities for terminal output.
 *
 * Plain text when the output is not a terminal (CI logs, a pipe, `> file`) or NO_COLOR is set (no-color.org);
 * FORCE_COLOR turns colors back on. Checked on every call, so a test or a caller can change it.
 */

export const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  underline: "\x1b[4m",

  // Foreground colors
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
} as const;

/** Whether to color: never with NO_COLOR, always with FORCE_COLOR (not "0"), else only on a terminal. */
export function useColor(env: NodeJS.ProcessEnv = process.env, tty: boolean | undefined = process.stdout.isTTY): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false") return true;
  return tty === true;
}

const paint = (code: string, text: string): string => (useColor() ? `${code}${text}${colors.reset}` : text);

export function red(text: string): string {
  return paint(colors.red, text);
}

export function yellow(text: string): string {
  return paint(colors.yellow, text);
}

export function green(text: string): string {
  return paint(colors.green, text);
}

export function cyan(text: string): string {
  return paint(colors.cyan, text);
}

export function dim(text: string): string {
  return paint(colors.dim, text);
}

export function bold(text: string): string {
  return paint(colors.bold, text);
}

export function underline(text: string): string {
  return paint(colors.underline, text);
}
