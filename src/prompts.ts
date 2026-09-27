import * as clack from '@clack/prompts';

export interface Choice<Value> { value: Value; label: string; hint?: string }

/** Interactive prompts behind an interface so command logic can be tested without a terminal. */
export interface Prompter {
  select<Value>(message: string, choices: Choice<Value>[], initial?: Value): Promise<Value>;
  multiselect<Value>(message: string, choices: Choice<Value>[], initial: Value[], required?: boolean): Promise<Value[]>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
  note(message: string, title?: string): void;
}

export class PromptCancelled extends Error {
  constructor() { super('Cancelled; no changes written.'); }
}

function answered<Value>(value: Value | symbol): Value {
  if (clack.isCancel(value)) throw new PromptCancelled();
  return value as Value;
}

export const terminalPrompter: Prompter = {
  async select(message, choices, initial) {
    return answered<typeof choices[number]['value']>(await clack.select({ message, options: choices as clack.Option<never>[], initialValue: initial as never }));
  },
  async multiselect(message, choices, initial, required = false) {
    return answered<typeof initial>(await clack.multiselect({ message, options: choices as clack.Option<never>[], initialValues: initial as never[], required }));
  },
  async confirm(message, initial = true) {
    return answered<boolean>(await clack.confirm({ message, initialValue: initial }));
  },
  note(message, title) { clack.note(message, title); },
};

export function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
