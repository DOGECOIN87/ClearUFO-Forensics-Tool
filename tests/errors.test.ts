// Plain-language error messages for browser API failures.
import { explainError } from "../src/shared/errors";

let fail = 0;
const ok = (name: string, cond: boolean, info = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${name}${info ? `  ${info}` : ""}`); if (!cond) fail++; };
const dom = (name: string, message = "") => Object.assign(new Error(message), { name });

// The exact message from the field: clipboard read denied on Android Chrome.
const denied = explainError(dom("NotAllowedError", "Failed to execute 'read' on 'Clipboard': Read permission denied."), "Paste Image", { permission: "clipboard" });
ok("permission denied is explained", !!denied && denied.includes("clipboard") && denied.includes("site settings"), denied ?? "");
ok("no developer jargon", !!denied && !denied.includes("Failed to execute") && !denied.includes("NotAllowedError"));
ok("cancel is silent", explainError(dom("AbortError", "The user aborted a request."), "Save Project") === null);
ok("closing the screen picker is a cancel", explainError(dom("NotAllowedError", "Permission denied by user"), "Video Input", { permission: "screen", notAllowedIsCancel: true }) === null);
ok("no camera", explainError(dom("NotFoundError", "Requested device not found"), "Video Input", { permission: "camera" }) === "Video Input: no camera was found on this device.");
ok("camera busy", (explainError(dom("NotReadableError", "Could not start video source"), "Video Input", { permission: "camera" }) ?? "").includes("in use by another app"));
ok("insecure page", (explainError(dom("SecurityError", "x"), "Copy Frame") ?? "").includes("https://"));
ok("unsupported", explainError(dom("NotSupportedError", "x"), "Copy Frame") === "Copy Frame: not supported by this browser.");
ok("storage full", (explainError(dom("QuotaExceededError", "x"), "Save Project") ?? "").includes("storage space"));
ok("unknown errors keep their message", explainError(new Error("the image could not be encoded"), "Copy Frame") === "Copy Frame failed: the image could not be encoded.".replace(/\.$/, ""));
ok("non-Error values", explainError("boom", "Paste Image") === "Paste Image failed: boom");
ok("empty", explainError(undefined, "Paste Image") === "Paste Image failed.");

if (fail) { console.error(`errors: ${fail} failed`); process.exit(1); }
console.log("errors: all tests passed");
