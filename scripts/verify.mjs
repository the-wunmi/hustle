// Checks a live Hustle world against NEAR testnet and NEAR AI Cloud, read-only: it signs nothing,
// needs no keys, and trusts the game's API only for what to look up. Every claim is read again from
// the chain (or from NEAR AI's attestation endpoint) and compared. Usage:
//   node scripts/verify.mjs [site URL]        (default https://hustle.clanker.show)
// Exit code 1 if any check fails. Network trouble on a public endpoint is a WARN, not a FAIL.
const site = (process.argv[2] ?? 'https://hustle.clanker.show').replace(/\/$/, '');
const RPCS = [
  'https://near-testnet.drpc.org',
  'https://test.rpc.fastnear.com',
  'https://testnet-rpc.intea.rs',
  'https://rpc.testnet.near.org',
];
const NEAR_AI = 'https://cloud-api.near.ai/v1';
const EMPTY_CODE = '11111111111111111111111111111111';

const results = { pass: 0, fail: 0, warn: 0 };
function report(kind, label, detail = '') {
  results[kind.toLowerCase()]++;
  console.log(`${kind.padEnd(4)} ${label}${detail ? `: ${detail}` : ''}`);
}
const pass = (l, d) => report('PASS', l, d);
const fail = (l, d) => report('FAIL', l, d);
const warn = (l, d) => report('WARN', l, d);
const section = (title) => console.log(`\n${title}`);

async function api(path) {
  const res = await fetch(`${site}/api${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}`);
  return res.json();
}

/** One JSON-RPC call, trying each public endpoint in turn (they rate-limit). */
async function rpc(method, params) {
  let last;
  for (let round = 0; round < 3; round++) {
    for (const url of RPCS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (body.error) {
          const cause = body.error.cause?.name ?? body.error.name ?? '';
          // An answer about the request (unknown account, method) is final; anything else retries.
          if (/UNKNOWN|NO_CONTRACT_CODE|CONTRACT_EXECUTION|INVALID/i.test(cause))
            return { error: body.error };
          throw new Error(body.error.message ?? cause);
        }
        return { result: body.result };
      } catch (err) {
        last = err;
      }
    }
    await new Promise((r) => setTimeout(r, 1000 * (round + 1)));
  }
  throw last;
}

async function view(account, method, args = {}) {
  const { result, error } = await rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  if (error) throw new Error(`${account}.${method}: ${error.cause?.name ?? error.message}`);
  if (!result.result) throw new Error(`${account}.${method}: ${result.error ?? 'no result'}`);
  return JSON.parse(Buffer.from(result.result).toString() || 'null');
}

async function account(id) {
  const { result, error } = await rpc('query', {
    request_type: 'view_account',
    finality: 'final',
    account_id: id,
  });
  return error ? null : result;
}

const hasCode = (a) =>
  !!a &&
  ((a.code_hash && a.code_hash !== EMPTY_CODE) ||
    !!a.global_contract_hash ||
    !!a.global_contract_account_id);

/** A transaction's outcome on chain: its status and the events its receipts logged. */
async function txOnChain(hash, sender) {
  const { result, error } = await rpc('tx', {
    tx_hash: hash,
    sender_account_id: sender,
    wait_until: 'NONE',
  });
  if (error) return null;
  const events = [];
  for (const o of result.receipts_outcome)
    for (const log of o.outcome.logs)
      if (log.startsWith('EVENT_JSON:')) events.push(JSON.parse(log.slice(11)));
  const failed = result.receipts_outcome.some((o) => 'Failure' in (o.outcome.status ?? {}));
  const value = result.status?.SuccessValue;
  return {
    signer: result.transaction.signer_id,
    receiver: result.transaction.receiver_id,
    ok: !('Failure' in (result.status ?? {})) && !failed,
    events,
    value: value ? Buffer.from(value, 'base64').toString() : null,
  };
}

/** The 64-byte report data inside a TDX quote v4 (bytes 568..632), as NEAR AI's docs describe. */
const reportData = (att) =>
  (att.report_data ?? (att.intel_quote ?? '').slice(1136, 1264)).toLowerCase();

const short = (s) => (s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s);

// ── The world ───────────────────────────────────────────────────────────────────────────────────

console.log(`Verifying ${site} against NEAR testnet and NEAR AI Cloud (read-only)`);
section('The game');
let world;
let agents;
try {
  const health = await api('/health');
  world = await api('/world');
  agents = await api('/agents');
  if (health.ok) pass('site is up', `tick ${health.tick}`);
  else fail('site is up', 'health not ok');
  if (world.modes?.chain === 'testnet')
    pass('plays on NEAR testnet', `AI: ${world.modes.inference}`);
  else fail('plays on NEAR testnet', `chain mode is ${world.modes?.chain}`);
} catch (err) {
  fail('site answers', err.message);
  process.exit(1);
}

const sample = agents.find((a) => a.accountId)?.accountId ?? '';
const root = sample.split('.').slice(2).join('.');
const ids = {
  credits: `credits.${root}`,
  registry: `agents.${root}`,
  jobs: `jobs.${root}`,
  reputation: `rep.${root}`,
  badges: `badges.${root}`,
  market: `market.${root}`,
};

section(`Contracts (root account ${root})`);
for (const [name, id] of Object.entries(ids)) {
  const a = await account(id);
  if (hasCode(a)) pass(`${name} contract deployed`, id);
  else fail(`${name} contract deployed`, `${id} has no code`);
}
{
  const a = await account(sample);
  if (hasCode(a)) pass('agent-wallet contract runs on every agent account', sample);
  else fail('agent-wallet contract runs on every agent account', `${sample} has no code`);
}

// ── Agents: NFT, holder, rulebook, reputation, badges ───────────────────────────────────────────

section('Agents are NFTs that are their own accounts');
const picked = [
  ...agents.filter((a) => !a.ownerName?.length || a.ownerName.includes('.')).slice(0, 1),
  ...agents.slice(0, 3),
].filter((a, i, all) => a.accountId && all.findIndex((b) => b.id === a.id) === i);
for (const agent of picked.slice(0, 4)) {
  const label = `${agent.name} (${agent.accountId})`;
  try {
    const proof = await api(`/agents/${agent.id}/proof`);
    const token = await view(ids.registry, 'nft_token', { token_id: agent.accountId });
    if (!token) {
      fail(`${label} is an NFT`, 'no such token on the registry');
      continue;
    }
    if (token.owner_id === proof.holder) pass(`${label} is an NFT held by ${proof.holder}`);
    else fail(`${label} holder`, `game says ${proof.holder}, chain says ${token.owner_id}`);
    const media = token.metadata?.media;
    if (media && agent === picked[0]) {
      const img = await fetch(media, { signal: AbortSignal.timeout(20_000) });
      const type = img.headers.get('content-type') ?? '';
      const svg = img.ok ? await img.text() : '';
      if (type.includes('svg') && svg.includes(agent.name))
        pass(`${agent.name}'s NFT image is drawn from its live state`, media);
      else fail(`${agent.name}'s NFT image`, `${media} answered ${img.status} ${type}`);
    } else if (!media && agent === picked[0])
      warn(
        `${agent.name}'s NFT image`,
        'the registry has no base URI set, so wallets show no image',
      );

    const wallet = await view(agent.accountId, 'get_wallet');
    const rb = wallet?.rulebook ?? {};
    const want = proof.wallet?.rulebook ?? {};
    const same = ['dailyCap', 'maxPerJob', 'maxPerCall'].every(
      (k) => String(rb[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]) === String(want[k]),
    );
    if (same)
      pass(
        `${agent.name}'s rulebook is enforced by its wallet`,
        `max ${want.maxPerCall} per call, ${want.maxPerJob} per job, ${want.dailyCap} a day; ${
          want.anyVendor ? 'any vendor' : `${want.allowedVendors.length} approved vendors`
        }`,
      );
    else fail(`${agent.name}'s rulebook`, 'the game and the wallet contract disagree');

    const rep = await view(ids.reputation, 'get_reputation', { agent_id: agent.accountId });
    const jobs = Number(rep?.jobs ?? rep?.jobs_completed ?? NaN);
    if (rep && jobs === Number(proof.reputation.jobs))
      pass(
        `${agent.name}'s record is on chain`,
        `${jobs} jobs, ${proof.reputation.scamsBlocked} scams blocked`,
      );
    else
      warn(
        `${agent.name}'s record`,
        `game ${proof.reputation.jobs} jobs, chain ${JSON.stringify(rep)?.slice(0, 120)}`,
      );

    if (proof.badges.length) {
      const held = await view(ids.badges, 'mt_batch_balance_of', {
        account_id: agent.accountId,
        token_ids: proof.badges.map((b) => b.tokenId),
      });
      const all = held.every((n) => BigInt(n) > 0n);
      if (all)
        pass(
          `${agent.name}'s badges sit on its own account (NEP-245)`,
          proof.badges.map((b) => b.title).join(', '),
        );
      else fail(`${agent.name}'s badges`, 'a badge the game lists is not held on chain');
    }
  } catch (err) {
    warn(label, err.message);
  }
}

// ── Money moves on chain ─────────────────────────────────────────────────────────────────────────

section('Payments are transactions');
try {
  const busiest = agents.slice().sort((a, b) => Number(b.balance) - Number(a.balance))[0];
  const all = await api(`/agents/${busiest.id}/txs`);
  const txs = all.slice(0, 5);
  let ok = 0;
  for (const t of txs) {
    const chain = await txOnChain(t.hash, t.signer);
    const sameOutcome = chain && chain.ok === (t.outcome === 'success');
    const sameEvents =
      chain && t.events.every((e) => chain.events.some((c) => c.event === e.event));
    if (sameOutcome && sameEvents) ok++;
    else
      fail(
        `tx ${short(t.hash)} (${t.method})`,
        chain ? 'outcome or events differ' : 'not found on chain',
      );
  }
  if (ok === txs.length)
    pass(
      `${busiest.name}'s last ${ok} transactions match the chain`,
      txs.map((t) => t.method).join(', '),
    );
  const paid = all.find((t) =>
    t.events.some((e) => e.event === 'job_settling' && e.data?.settlement === 'paid'),
  );
  if (paid) {
    const chain = await txOnChain(paid.hash, paid.signer);
    if (!chain?.events.some((e) => e.event === 'job_settling'))
      fail('a job paid from escrow', `tx ${short(paid.hash)} not confirmed`);
    const ev = paid.events.find((e) => e.event === 'job_settling');
    const payout = ev.data.transfers.find((x) => x.purpose === 'agent_payout');
    pass(
      'a job paid from escrow',
      `job ${ev.data.job_id}: ${payout.amount} credits to ${payout.receiver_id}, tx ${short(paid.hash)}`,
    );
  }
} catch (err) {
  warn('payments', err.message);
}

section("A scam payment refused by the agent's wallet");
try {
  const recent = await api('/jobs?status=recent&limit=300');
  const list = Array.isArray(recent) ? recent : (recent.jobs ?? []);
  let shown = false;
  for (const j of list.filter((x) => x.wasScam).slice(0, 40)) {
    const job = await api(`/jobs/${j.id}`);
    const blocked = job.spends.find((s) => s.status === 'blocked' && s.txHash);
    if (!blocked) continue;
    const chain = await txOnChain(blocked.txHash, `orchestrator.${root}`);
    const ev = chain?.events.find((e) => e.event === 'spend_blocked');
    if (ev && ev.data.receiver_id === blocked.receiver)
      pass(
        `"${job.title}"`,
        `${blocked.agentName}'s wallet refused ${blocked.amount} credits to ${blocked.receiver} (${ev.data.reason}), tx ${short(blocked.txHash)}`,
      );
    else
      fail(`"${job.title}"`, `blocked payment tx ${short(blocked.txHash)} not confirmed on chain`);
    shown = true;
    break;
  }
  if (!shown)
    warn(
      'scam refusal',
      'no blocked payment among recent scam jobs (they come every few game days)',
    );
} catch (err) {
  warn('scam refusal', err.message);
}

// ── Attested AI ──────────────────────────────────────────────────────────────────────────────────

section("Agents' AI replies are signed by an attested key");
try {
  let receipt;
  for (const a of agents) {
    const proof = await api(`/agents/${a.id}/proof`);
    receipt = proof.inference.find((i) => i.source === 'live' && i.signer);
    if (receipt) {
      receipt.agent = a.name;
      break;
    }
  }
  if (!receipt) warn('live receipts', 'no live NEAR AI reply recorded yet');
  else {
    const nonce = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const q = new URLSearchParams({ nonce, signing_algo: 'ecdsa', model: receipt.model });
    const res = await fetch(`${NEAR_AI}/attestation/report?${q}`, {
      signal: AbortSignal.timeout(30_000),
    });
    const report = await res.json();
    const att = (report.model_attestations ?? []).find((m) => m.model_name === receipt.model);
    if (!att) warn('attestation', `NEAR AI returned no attestation for ${receipt.model}`);
    else {
      const data = reportData(att);
      const addr = att.signing_address.toLowerCase().replace(/^0x/, '');
      if (att.request_nonce === nonce && data.slice(64, 128) === nonce)
        pass('a fresh attestation answers our own nonce', `${receipt.model}`);
      else fail('fresh attestation', 'the report does not carry our nonce');
      if (data.slice(0, 40) === addr)
        pass('the attested report names its signing key', att.signing_address);
      else fail('attested key', 'report data does not name the signing key');
      if (att.signing_address.toLowerCase() === receipt.signer.toLowerCase())
        pass(
          `${receipt.agent}'s reply was signed by that key`,
          `${receipt.purpose} at ${receipt.at}`,
        );
      else
        warn(
          `${receipt.agent}'s reply signer`,
          `${receipt.signer} (the model's key has rotated since)`,
        );
      console.log(
        '     Not checked here: the Intel TDX quote itself against Intel collateral, and GPU evidence.',
      );
    }
  }
} catch (err) {
  warn('attestation', err.message);
}

console.log(`\n${results.pass} passed, ${results.fail} failed, ${results.warn} warnings`);
process.exit(results.fail ? 1 : 0);
