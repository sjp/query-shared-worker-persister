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
    case "object":
      if (value === null) {
        return "null";
      }
      return Array.isArray(value) ? "an array" : "an object";
    default:
      // Unreachable across the `typeof` results this build knows about, and
      // kept so a future one still gets a name instead of `undefined` - this
      // function is called to describe a fault and must never add one.
      return "a value of an unknown type";
  }
}
