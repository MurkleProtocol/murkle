// /app: the gate. No vault: onboarding. Vault: the lock screen. A zkpool-era
// plaintext phrase: the forced "Protect your wallet with a password" screen.
// Unlocked: the portfolio.
import { withWallet } from "./app-shared.js";
import { renderPortfolio } from "./app-portfolio.js";

export function render(root) {
  return withWallet(root, (s) => renderPortfolio(root, s));
}
