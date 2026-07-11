export function isDebugMode(): boolean {
  return process.env.SINSCRIBE_DEBUG === "1";
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
