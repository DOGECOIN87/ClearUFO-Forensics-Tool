// Plain-language explanations for the browser errors people actually run into (permissions,
// missing devices, unsupported features, cancelled pickers). The browsers' own messages, such as
// "Failed to execute 'read' on 'Clipboard': Read permission denied.", are for developers.

export interface ErrorLike { name?: string; message?: string }

export interface ExplainOptions {
  /** What the permission is called for the user, e.g. "clipboard" or "camera". */
  permission?: string;
  /** Treat NotAllowedError as a cancel (e.g. the user closed the screen-sharing picker). */
  notAllowedIsCancel?: boolean;
}

/**
 * Turns an exception from a browser API into a sentence for the user, starting with `action`
 * (e.g. "Paste Image"). Returns null when the user deliberately cancelled: nothing to report.
 */
export function explainError(e: unknown, action: string, o: ExplainOptions = {}): string | null {
  const err = (e && typeof e === "object" ? e : { message: String(e ?? "") }) as ErrorLike;
  const name = err.name ?? "";
  switch (name) {
    case "AbortError":
      return null;
    case "NotAllowedError":
      if (o.notAllowedIsCancel) return null;
      return o.permission
        ? `${action}: access to the ${o.permission} was not allowed. Allow it for this site in the browser's site settings (the icon next to the address), then try again.`
        : `${action}: the browser did not allow this. Try again directly from the menu or toolbar.`;
    case "SecurityError":
      return `${action}: blocked by the browser on this page (it requires a secure https:// page).`;
    case "NotFoundError":
      return o.permission ? `${action}: no ${o.permission} was found on this device.` : `${action}: the item was not found.`;
    case "NotReadableError":
      return `${action}: the ${o.permission ?? "device"} is in use by another app or cannot be accessed.`;
    case "OverconstrainedError":
      return `${action}: the ${o.permission ?? "device"} does not support the requested settings.`;
    case "NotSupportedError":
      return `${action}: not supported by this browser.`;
    case "QuotaExceededError":
      return `${action}: there is not enough storage space.`;
  }
  const msg = (err.message ?? "").trim();
  return msg ? `${action} failed: ${msg}` : `${action} failed.`;
}
