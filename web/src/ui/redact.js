/**
 * Redaction (visual.md section 6.7): what a zero-knowledge proof hides is drawn as a hatched
 * bar, never as "***".
 *
 * API
 *   REDACT_LABEL                    accessible label
 *   REDACT_TIP                      tooltip for amount, token and recipient
 *   redactTip(kind) -> string       tooltip per kind: sender and spent notes say only the sender
 *                                   knows them (the note plaintext carries neither)
 *   redact(kind = "amount" | "token" | "address" | "sender" | "recipient" | "spent", { tip })
 *       -> Safe bar (7ch amount, 5ch token, 14ch address/sender/recipient/spent).
 *          "spent" = which notes a transfer spent; `tip` replaces the tooltip.
 *   revealed(value, { source = "received" | "sent" | "local" })
 *       -> Safe real value with a dashed outline and the caption that says where it came from:
 *          received -> "decrypted in this browser", sent -> "from your history on this device"
 *          `value` may be text or Safe markup.
 *   viewToggle({ mine = false, name }) -> Safe segmented control "Observer view | My view"
 *       (data-seg; listen for the "seg-change" event on it, detail = { value: "observer"|"mine" }).
 */
import { html } from "./dom.js";
import { icon } from "./icons.js";
import { segmented } from "./components.js";

export const REDACT_LABEL = "Hidden by zero-knowledge proof";
export const REDACT_TIP = "Not readable on Bitcoin. Only the sender and recipient can see it.";

const WIDTH = { amount: "amount", token: "token", address: "address", sender: "address", recipient: "address", spent: "address" };

// The note plaintext is token, amount and blinding only (SPEC section 3), so the recipient
// learns neither the sender nor which notes were spent.
const TIP = {
  amount: REDACT_TIP,
  token: REDACT_TIP,
  recipient: REDACT_TIP,
  sender: "Hidden by the proof. Only the sender knows it; the recipient doesn't learn it either.",
  spent: "Hidden by the proof. Only the sender knows which notes were spent.",
};

export const redactTip = (kind) => TIP[kind] ?? "Not readable on Bitcoin.";

export function redact(kind = "amount", { tip = null } = {}) {
  const w = WIDTH[kind] ?? "amount";
  return html`<span class="redact redact--${w}" role="img" aria-label="${REDACT_LABEL}" data-tip="${tip ?? redactTip(kind)}" tabindex="0">${icon("lock", { size: 9, inline: true })}</span>`;
}

const SOURCE = {
  received: "decrypted in this browser",
  sent: "from your history on this device",
  local: "from this device",
};

export function revealed(value, { source = "received" } = {}) {
  return html`<span class="revealed"><span class="revealed-v">${value}</span><span class="revealed-c caption">${SOURCE[source] ?? source}</span></span>`;
}

export function viewToggle({ mine = false, name = "view" } = {}) {
  return segmented(
    [
      { value: "observer", label: "Observer view" },
      { value: "mine", label: "My view" },
    ],
    { value: mine ? "mine" : "observer", name, label: "Choose what to show" },
  );
}
