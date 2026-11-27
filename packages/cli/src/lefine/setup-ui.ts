/**
 * The terminal side of `lefine setup`: @clack/prompts (the same library add-mcp uses), behind a small
 * interface so the flow can be tested with a fake. Prompts and progress go to stdout through clack.
 */

import * as p from "@clack/prompts";

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface SetupUi {
  intro(title: string): void;
  /** Plain lines under the current step. */
  line(text: string): void;
  warn(text: string): void;
  multiselect<T extends string>(message: string, options: Choice<T>[], initial: T[]): Promise<T[] | null>;
  select<T extends string>(message: string, options: Choice<T>[]): Promise<T | null>;
  confirm(message: string, initial: boolean): Promise<boolean | null>;
  /** Shows a spinner while `work` runs. */
  spin<R>(message: string, work: () => Promise<R>, done: (r: R) => string): Promise<R>;
  outro(text: string): void;
}

const unwrap = <T>(v: T | symbol): T | null => (p.isCancel(v) ? null : (v as T));

export const clackUi: SetupUi = {
  intro: (title) => p.intro(title),
  line: (text) => p.log.message(text),
  warn: (text) => p.log.warn(text),
  async multiselect(message, options, initial) {
    const r = await p.multiselect({
      message,
      options: options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })) as never,
      initialValues: initial,
      required: false,
    });
    return unwrap(r) as never;
  },
  async select(message, options) {
    const r = await p.select({ message, options: options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })) as never });
    return unwrap(r) as never;
  },
  async confirm(message, initial) {
    return unwrap(await p.confirm({ message, initialValue: initial }));
  },
  async spin(message, work, done) {
    const s = p.spinner();
    s.start(message);
    const r = await work();
    s.stop(done(r));
    return r;
  },
  outro: (text) => p.outro(text),
};
