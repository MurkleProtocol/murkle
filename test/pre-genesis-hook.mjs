// Module-loader hook for tests (node --import test/pre-genesis-register.mjs ...): the process sees
// src/pins.mainnet.json as it was before the mainnet launch (no genesis, no activation height, MURK
// not pinned, mining height null), so the pre-genesis branches stay covered now that the shipped
// file pins the launch. Only that one file is rewritten; nothing on disk changes.
export async function load(url, context, nextLoad) {
  const out = await nextLoad(url, context);
  if (!/\/src\/pins\.mainnet\.json$/.test(url)) return out;
  const pins = JSON.parse(String(out.source));
  pins.genesisTxid = null;
  pins.activationHeight = null;
  pins.reservedTickers = { MURK: null };
  pins.activations = (pins.activations ?? []).map((a) => ({ ...a, height: null }));
  return { ...out, source: JSON.stringify(pins) };
}
