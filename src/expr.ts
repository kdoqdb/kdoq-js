/** An expression in the query language, as an operand of `set` or `replace`. */
export interface Operand {
  readonly expression: string;
}
export const expr = (text: string): Operand => ({ expression: text });
