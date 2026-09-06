const MAX_QUOTED_LENGTH = 64;

/**
 * Name an arbitrary value for an error or log message without ever throwing.
 *
 * The obvious choice, `JSON.stringify`, is not safe here: it throws a
 * `TypeError` for a `bigint` and for an object that contains a cycle.
 */
export function describeValue(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value.length > MAX_QUOTED_LENGTH
        ? `${JSON.stringify(value.slice(0, MAX_QUOTED_LENGTH))}... (${value.length} characters)`
        : JSON.stringify(value);
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
