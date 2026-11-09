/** Stable application failures: locale is chosen only at the UI boundary. */
export class UserError extends Error {
  constructor(
    public readonly code: string,
    public readonly params: Record<string, string | number> = {},
  ) {
    super(
      `${code}${Object.keys(params).length ? ": " + JSON.stringify(params) : ""}`,
    );
    this.name = "UserError";
  }
}
export function errorState(error: unknown) {
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof UserError
      ? { errorCode: error.code, errorParams: error.params }
      : {}),
  };
}
