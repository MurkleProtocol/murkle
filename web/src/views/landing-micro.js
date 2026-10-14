// The small print under the landing hero buttons. "Test coins only" is true on signet only; mainnet
// adds nothing in its place (its banner already says what it has to). A module of its own so a test
// can render it for both networks without loading the whole landing page.
import { html } from "../ui/dom.js";
import { icon } from "../ui/icons.js";

export const heroMicro = (signet) => html`<p class="ld-micro"><span>${icon("check", { size: 14 })}No sign-up</span><span>${icon("lock", { size: 14 })}Keys never leave your device</span>${signet ? html`<span>${icon("warn", { size: 14 })}Test coins only</span>` : ""}</p>`;
