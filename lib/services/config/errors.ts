/** Validation failures carry every violated rule at once so the editor can mark fields. */
export type ConfigIssue = { field: string; message: string };

export class ConfigValidationError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(issues.map((i) => `${i.field}: ${i.message}`).join("; ") || "Invalid configuration");
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export class ConfigForbiddenError extends Error {
  constructor(message = "Only the team owner or the commissioner may edit this config") {
    super(message);
    this.name = "ConfigForbiddenError";
  }
}

export class ConfigNotFoundError extends Error {
  constructor(message = "Config not found") {
    super(message);
    this.name = "ConfigNotFoundError";
  }
}
