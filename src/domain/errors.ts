/** User-facing failure: printed as a clean message, exit code 1, no stack. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}
