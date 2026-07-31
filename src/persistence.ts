export type AltairDraftPersistenceErrorCode =
  | "conflict"
  | "quota"
  | "unavailable"
  | "invalid-data"
  | "operation-failed";

export class AltairDraftPersistenceError extends Error {
  readonly code: AltairDraftPersistenceErrorCode;

  constructor(
    code: AltairDraftPersistenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AltairDraftPersistenceError";
    this.code = code;
  }
}

export class AltairDraftPersistenceConflictError
  extends AltairDraftPersistenceError {
  readonly expectedRevision: number | null;
  readonly actualRevision: number | null;

  constructor(
    message: string,
    expectedRevision: number | null,
    actualRevision: number | null,
    options?: ErrorOptions,
  ) {
    super("conflict", message, options);
    this.name = "AltairDraftPersistenceConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class AltairDraftPersistenceQuotaError
  extends AltairDraftPersistenceError {
  constructor(message: string, options?: ErrorOptions) {
    super("quota", message, options);
    this.name = "AltairDraftPersistenceQuotaError";
  }
}

export class AltairDraftPersistenceUnavailableError
  extends AltairDraftPersistenceError {
  constructor(message: string, options?: ErrorOptions) {
    super("unavailable", message, options);
    this.name = "AltairDraftPersistenceUnavailableError";
  }
}

const errorName = (error: unknown): string | undefined =>
  error && typeof error === "object" && "name" in error
    ? String((error as { readonly name?: unknown }).name)
    : undefined;

export const normalizeAltairDraftPersistenceError = (
  error: unknown,
  operation: string,
): AltairDraftPersistenceError => {
  if (error instanceof AltairDraftPersistenceError) return error;
  if (errorName(error) === "QuotaExceededError") {
    return new AltairDraftPersistenceQuotaError(
      `Altair draft persistence quota was exceeded while ${operation}`,
      { cause: error },
    );
  }
  if (
    errorName(error) === "InvalidStateError" ||
    errorName(error) === "NotFoundError"
  ) {
    return new AltairDraftPersistenceUnavailableError(
      `Altair draft persistence is unavailable while ${operation}`,
      { cause: error },
    );
  }
  return new AltairDraftPersistenceError(
    "operation-failed",
    `Altair draft persistence failed while ${operation}`,
    { cause: error },
  );
};
