# Honest copy: claims rules

Every user-facing sentence (web app, CLI, README, release notes, posts) follows these rules. `test/english.test.mjs` and the copy tests enforce the parts a test can check; `docs/design/visual.md` §2 has the full copy and word lists for the web app.

## Approved headlines
- "Private tokens on Bitcoin. Every proof lives on-chain. Your browser checks every one."
- "Amounts, tokens and recipients of private transfers are hidden. The proof that each transfer is valid is public, in a Bitcoin transaction." Whether anyone can tell who sent a transfer depends on who pays its fee and how many others use the pool: never list the sender as hidden for a self-paid, linkable or thin-pool send (privacy-trace-test.md).
- "Don't trust our website: replay the whole pool from raw Bitcoin blocks in your browser, or with one command."
- "The circuit and keys are fingerprinted on Bitcoin in tx <genesis>, and the wallet refuses anything else."
- "Relay from my balance (optional, prepaid): the relayer's coins go on the transfer, not your address; the relayer can link the address you top up from to the transfers it carries for you (docs/design/relay-balance.md)." Only while the relay pool has cover: while too few people have topped up, the carrier's input can tie the send to your top-up address, and the wallet says so and sends only if you confirm it linkable.
- "One shared pool for every token: each launch grows everyone's crowd."

## Never say
- "Bitcoin verifies / enforces the proofs", "secured by Bitcoin consensus". This is a metaprotocol: Bitcoin orders and timestamps the data, and replayers verify it.
- "Trustless", "fully anonymous", "untraceable", "unbreakable", "military-grade".
- "Audited" without the word "internally".
- "Secure trusted setup", or that a ceremony has happened, before it has (describing the planned public ceremony and its tooling is fine).
- "Mainnet-ready", "live on mainnet", or anything that says mainnet has launched before a mainnet genesis is pinned: until then mainnet is "not launched".
- "Decentralized indexers" before independent operators exist.
- Any anonymity percentage, or counts of people (count transfers).
- "Free", "sponsored" or "gasless" relaying: there is no free mode, and the operator never pays a user's fee.

## Required disclosures
- The network. Signet: test network; the tokens have no value. Mainnet before genesis: "Murkle has not launched on Bitcoin mainnet. No genesis is pinned, so nothing here can move funds." Mainnet after genesis: experimental software; tokens may be worth money and can be lost to bugs.
- Internal review only (circomspect, Picus, manual); no external audit yet.
- The phase-2 trusted setup (A-8), per network. Signet: a DEV setup from a single party, kept by design because the signet genesis pins it; whoever ran it could forge proofs. Mainnet: until the public ceremony has run, no mainnet proving key is pinned; after it, "public ceremony <id>, N contributions, beacon block H: secure if at least one contributor discarded their secret".
- Chain data (A-9), per network. Both: headers are checked for proof of work and the difficulty rules from a pinned checkpoint; a single data source (mempool.space in the browser) can still hide or delay blocks, and your own node removes it for the indexer. Signet: signet blocks are valid by a signature that is not checked, and signet proof of work is nearly free. Mainnet: the chain with the most work wins among those the data source serves. Receipts say which header check applied (your replay's header chain, linked headers above the block, or its own target bounded by the checkpoint).
- Mints are public (token, amount, payer). The address that pays a transfer's fee is tied to it on Bitcoin.
- The anonymity set is small while the pool is early. The proof's anchor fixes how many notes were in the tree, so with few notes it can point to the sender; a batch hides nothing while it holds only your transfer. Wallets show the crowd before a relayed or batch send and warn when it is small.
- Relay pool cover: while too few people have topped up the relay pool, a relayed send's input ties it to your top-up address on chain. The relayer refuses it (`pool_thin`) unless you confirm to send it linkable; a linkable send is never shown as hiding its sender.
- A leak of the relayer's files shows each account's balance under an opaque key, and recent top-ups with their accounts. Older top-ups no longer say whose they were, so the files alone do not give what each account spent; but an account whose top-ups are all recent can still be matched to its carriers, and with only a handful of accounts and sends the balances, the public deposit values and the public fees can be fitted together to name who sent what.
- A relay balance is prepaid: you top up before you relay. The relayer can link the address you top up from to every transfer you relay with that balance, and a send made right after a top-up confirms is easy to link while few people relay; topping up ahead of time or a batch mode hides this better.

## Mining
Mined tokens are issued by proof of work (`docs/design/mining.md`). Pages and the CLI say "Mine" and "the reward goes to a private note". Mining is off until its activation height is set in `src/pins.json`; nothing may say it is live before then.

Exact copy (`docs/design/mining-contract.md` §12; the amount and the recipient come from `MINE_FEE` in `src/params.mjs`):
- Relay route: "The reward goes to a private note. Chain observers see relay claims of TICKER for R each, not who received them. The relayer can link the address you top up from to every claim it carries for you, including the token and the reward. While few people relay claims, the claims right after your top-up are easy to tie to it. Top up before you start mining."
- Built-in key, Unisat or the CLI's mining key: "Claims are public: token, reward and the paying address. Anyone can add up what this address mined, and the transfers it pays for later."
- Every route: "A single GPU or a server miner can be thousands of times faster than this tab. Anyone can rent many computers." (the CLI says "this miner")
- "Every claim pays a Bitcoin fee and a service fee of 500 sats to the Murkle platform address. Its own claims cost it 500 sats less."
- "Bitcoin miners choose what goes into blocks and in what order. They can delay a claim until it expires."
- Near the cap: "Supply is nearly mined out. A claim that lands after the cap is rejected; its Bitcoin fee and its service fee are still spent."
- "A claim must land within 12 blocks of the block it references."
- "Difficulty jumped. Solutions found before the jump may no longer count; the wallet checks before paying."
- "The fee recipient can block a fee bump, so the wallet pays a next-block rate up front."
- "Test coins, no value." Phones: "Mining keeps the processor busy: expect battery drain and heat."
- Launch: "Difficulty is noisy: with few solutions per span, emission runs a few percent above target." and "After a quiet period or a hashrate jump, the first block can carry many claims."

Required disclosures for mining:
- What the relayer sees. The transfer sentence "It cannot see amounts, tokens or recipients" is true for transfers only and is never shown for mining: for each claim it carries, the relayer learns the token and the reward, and it links them to the account, the top-up address, the IP address and the time.
- The fee recipient mines at a discount: its own claims pay the 500-sat service fee back to itself, so a claim costs it only the Bitcoin fee. The token page, the Mine page, the launch form and the CLI say so.
- Hardware: faster hardware finds more, and a GPU is roughly 300 to 500 times one browser thread. The hashrate shown is an estimate from counted work.
- Bitcoin miners and the relayer can delay or reorder claims; neither can redirect a reward or forge work.
- The deployer knows the terms first and chooses the start: now, at the launch block itself, or after N blocks. Starting now favours whoever is ready first; a delay gives everyone time to see the terms. The token page says which one a launch chose; claim no more fairness than that.
- A claim that lands after the supply cap, or after its 12-block window, is rejected and its fees are spent.

Never say (mining, in addition to the list above): "anonymous", "untraceable", "trustless", "mixer", "free", "sponsored", "fair launch guaranteed", "GPU-resistant", "ASIC-resistant", "no head start". The internal name of the design is never user copy.
