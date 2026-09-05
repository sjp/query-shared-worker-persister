/**
 * Name an arbitrary value for an error or log message without ever throwing.
 *
 * The obvious choice, `JSON.stringify`, is not safe here: it throws a
 * `TypeError` for a `bigint` and for an object that contains a cycle, and both
 * of those survive structured cloning, so either can arrive on the port from
 * any same-origin script that opens this worker. A description that throws
 * would take down the very handler whose job is to explain the problem.
 *
 * Primitives are spelled out because their value is the useful part; anything
 * else is named by its type, since printing its contents is what risks a throw.
 */
export function describeValue(value: unknown): string {
  switch (typeof value) {
    case "string":
      // Safe: `JSON.stringify` only throws on values a string can't be, and
      // quoting makes an empty or space-padded string visible in the message.
      return JSON.stringify(value);
    case "bigint":
      return `${value}n`;
    case "symbol":
      return value.toString();
    case "number":
    case "boolean":
    case "undefined":
      return String(value);
    case "function":
      return "a function";
    default:
      if (value === null) return "null";
      return Array.isArray(value) ? "an array" : "an object";
  }
}
