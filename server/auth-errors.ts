/** Preserve typed terminal authentication failures through proxy wrappers.
 * Do not infer authentication state from arbitrary provider error text. */
export function terminalAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; reauthenticationRequired?: boolean };
  return (
    e.reauthenticationRequired === true ||
    [
      "auth_required",
      "authentication_required",
      "invalid_grant",
      "interaction_required",
      "login_required",
      "signin_required",
      "permission_unavailable",
      "invalid_credentials",
      "account_mismatch",
      "permission_denied",
    ].includes(e.code ?? "")
  );
}
