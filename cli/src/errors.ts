// Shared error types. Kept in one small module so every other module (and the
// stub verbs) can throw structured errors without importing each other.

/** Bad CLI invocation (unknown verb/flag, missing argument). Maps to exit 1. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Registry failed schema validation. */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/** Machine config invalid, or a registered root is missing on disk (hard abort). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
