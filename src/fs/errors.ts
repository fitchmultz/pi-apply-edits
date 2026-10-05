export class PublicationError extends Error {
  readonly modifiedFiles: string[];
  readonly uncertainFiles: string[];

  constructor(
    message: string,
    modifiedFiles: readonly string[] = [],
    uncertainFiles: readonly string[] = [],
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "PublicationError";
    this.modifiedFiles = [...modifiedFiles];
    this.uncertainFiles = [...uncertainFiles];
  }
}

export class PartialCreatePublishError extends PublicationError {
  readonly publishedFiles: number;

  constructor(
    message: string,
    publishedFiles: number,
    modifiedFiles: readonly string[] = [],
    uncertainFiles: readonly string[] = [],
  ) {
    super(message, modifiedFiles, uncertainFiles);
    this.name = "PartialCreatePublishError";
    this.publishedFiles = publishedFiles;
  }
}

export class AtomicMoveUncertainError extends Error {}

export function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : describeUnknown(error);
}

function describeUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return "Non-Error failure";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new Error("Operation aborted before file content was committed");
  }
}
