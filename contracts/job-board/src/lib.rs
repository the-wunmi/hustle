//! Job board and escrow. Clients post jobs by sending credits with `ft_transfer_call`; the budget
//! stays here until the job settles. Payouts always go to the agent wallet, never its holder.
//!
//! Storage: a live job is paid from this contract's balance and bounded by string caps; posting one
//! locks at least `MIN_BUDGET` of the client's credits, and settled jobs are removed. The settled-key
//! memory is a fixed-size ring.

use hustle_common::{ext_ft, is_agent_wallet, promise_succeeded, GAS_FOR_FT_TRANSFER, MAX_AMOUNT};
use near_sdk::json_types::U128;
use near_sdk::serde_json;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    PromiseOrValue,
};

/// Smallest budget a job may escrow: ten cents. A live job costs this contract about 0.005 NEAR of
/// storage, so every job must lock real money; smaller deposits are refunded.
pub const MIN_BUDGET: u128 = 100_000;

/// Highest platform fee: 20%. Guards against a fat-fingered `fee_bps` at deploy time.
pub const MAX_FEE_BPS: u16 = 2_000;

/// Longest client-chosen job key (the engine's keys are a prefix plus a UUID).
pub const MAX_JOB_KEY_LEN: usize = 64;

/// Longest spec or work hash (a prefixed sha256 in hex is 71 characters).
pub const MAX_HASH_LEN: usize = 128;

/// Longest review window: seven days, so escrow is never locked for longer than a week after
/// delivery without the client acting.
pub const MAX_REVIEW_WINDOW_MS: u64 = 7 * 86_400_000;

/// Delivery deadline when the post names none: one real day.
pub const DEFAULT_DELIVERY_WINDOW_MS: u64 = 86_400_000;

/// Shortest delivery deadline: one minute (a few game ticks), so a client cannot award and reclaim
/// before the agent had any chance to deliver.
pub const MIN_DELIVERY_WINDOW_MS: u64 = 60_000;

/// Longest delivery deadline: seven days, so an awarded budget is never locked for longer.
pub const MAX_DELIVERY_WINDOW_MS: u64 = 7 * 86_400_000;

/// Settled job keys remembered so a re-post of a finished job is refunded rather than paid twice.
/// 256 covers the engine's reconcile horizon by a wide margin at a fixed cost of about 40 KB.
pub const SETTLED_KEY_MEMORY: u32 = 256;

/// Most jobs returned by one `get_jobs` call, to keep view gas bounded.
pub const MAX_PAGE: u64 = 100;

/// Rating used when the client lets the review window lapse.
pub const EXPIRED_RATING: u8 = 4;

const BPS_DENOMINATOR: u128 = 10_000;
const GAS_FOR_PAYOUT_CALLBACK: Gas = Gas::from_tgas(15);
const GAS_FOR_REP_RECORD: Gas = Gas::from_tgas(10);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Jobs,
    JobKeys,
    SettledKeys,
    SettledRing,
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobStatus {
    Open,
    Awarded,
    Delivered,
    Disputed,
    /// Settled; payouts or refunds are in flight.
    Settling,
    /// Settled, but at least one transfer failed; `retry_payout` resends it.
    PayoutFailed,
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Settlement {
    /// The agent was paid (accepted, expired review window, or dispute won).
    Paid,
    /// The arbiter refunded the client after a dispute.
    Refunded,
    /// The client cancelled before award.
    Cancelled,
    /// The client took the escrow back: the agent missed the delivery deadline, or its payout kept
    /// failing for a delivery window after settlement.
    Reclaimed,
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    AgentPayout,
    Fee,
    Refund,
}

/// One credits transfer out of escrow.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transfer {
    pub receiver_id: AccountId,
    pub amount: U128,
    pub purpose: Purpose,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Job {
    pub job_id: u64,
    pub job_key: String,
    pub client_id: AccountId,
    pub spec_hash: String,
    pub auto_award: bool,
    pub review_window_ms: u64,
    /// Time after award by which the agent must deliver, else `reclaim_undelivered` refunds the client.
    pub delivery_window_ms: u64,
    /// The amount posted.
    pub budget: U128,
    /// What is still held for this job (budget, then price after award, then what is owed).
    pub escrow: U128,
    pub status: JobStatus,
    pub agent_id: Option<AccountId>,
    pub price: Option<U128>,
    pub work_hash: Option<String>,
    pub posted_at_ms: u64,
    pub awarded_at_ms: Option<u64>,
    pub delivered_at_ms: Option<u64>,
    pub settled_at_ms: Option<u64>,
    pub settlement: Option<Settlement>,
    /// Transfers that failed and wait for `retry_payout`.
    pub owed: Vec<Transfer>,
    /// Transfers sent whose callbacks have not run yet.
    pub in_flight: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PostArgs {
    pub job_key: String,
    pub spec_hash: String,
    pub auto_award: bool,
    pub review_window_ms: u64,
    /// Defaults to `DEFAULT_DELIVERY_WINDOW_MS`.
    #[serde(default)]
    pub delivery_window_ms: Option<u64>,
}

#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
pub enum TransferMsg {
    Post(PostArgs),
}

/// Must serialise exactly like the reputation contract's `Outcome`.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug)]
pub enum RepOutcome {
    Completed,
    DisputeWon,
    DisputeLost,
}

#[ext_contract(ext_rep)]
pub trait Reputation {
    fn record(
        &mut self,
        agent_id: AccountId,
        job_id: String,
        outcome: RepOutcome,
        rating: Option<u8>,
    );
}

#[near(event_json(standard = "hustle"))]
pub enum JobEvent<'a> {
    #[event_version("1.0.0")]
    JobPosted {
        job_id: u64,
        job_key: &'a str,
        client_id: &'a AccountId,
        budget: U128,
        auto_award: bool,
    },
    #[event_version("1.0.0")]
    PostRefunded {
        sender_id: &'a AccountId,
        amount: U128,
        reason: &'a str,
    },
    #[event_version("1.0.0")]
    JobAwarded {
        job_id: u64,
        agent_id: &'a AccountId,
        price: U128,
    },
    #[event_version("1.0.0")]
    JobDelivered {
        job_id: u64,
        agent_id: &'a AccountId,
        work_hash: &'a str,
    },
    #[event_version("1.0.0")]
    JobDisputed { job_id: u64 },
    #[event_version("1.0.0")]
    JobSettling {
        job_id: u64,
        settlement: Settlement,
        rating: Option<u8>,
        transfers: &'a [Transfer],
    },
    #[event_version("1.0.0")]
    PayoutFailed { job_id: u64, transfer: &'a Transfer },
    #[event_version("1.0.0")]
    JobSettled {
        job_id: u64,
        job_key: &'a str,
        settlement: Settlement,
    },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct JobBoard {
    owner_id: AccountId,
    operator_id: AccountId,
    credits_id: AccountId,
    registry_id: AccountId,
    rep_id: AccountId,
    treasury_id: AccountId,
    fee_bps: u16,
    next_job_id: u64,
    jobs: IterableMap<u64, Job>,
    /// Live jobs by key, for duplicate detection and in-doubt reconciliation.
    job_keys: LookupMap<String, u64>,
    /// Keys of recently settled jobs (with their ring slot so eviction can find them).
    settled_keys: LookupMap<String, u32>,
    settled_ring: Vector<String>,
    settled_cursor: u32,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner_id: AccountId,
    pub operator_id: AccountId,
    pub credits_id: AccountId,
    pub registry_id: AccountId,
    pub rep_id: AccountId,
    pub treasury_id: AccountId,
    pub fee_bps: u16,
    pub min_budget: U128,
}

#[near]
impl JobBoard {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner_id: AccountId,
        operator_id: AccountId,
        credits_id: AccountId,
        registry_id: AccountId,
        rep_id: AccountId,
        treasury_id: AccountId,
        fee_bps: u16,
    ) -> Self {
        require!(fee_bps <= MAX_FEE_BPS, "fee_too_high");
        Self {
            owner_id,
            operator_id,
            credits_id,
            registry_id,
            rep_id,
            treasury_id,
            fee_bps,
            next_job_id: 0,
            jobs: IterableMap::new(StorageKey::Jobs),
            job_keys: LookupMap::new(StorageKey::JobKeys),
            settled_keys: LookupMap::new(StorageKey::SettledKeys),
            settled_ring: Vector::new(StorageKey::SettledRing),
            settled_cursor: 0,
        }
    }

    /// NEP-141 receiver, credits token only. Returns the amount to refund: all of it when the post is
    /// refused, nothing when the job is stored.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.credits_id,
            "wrong_token"
        );
        match self.post(&sender_id, amount.0, &msg) {
            Ok(()) => PromiseOrValue::Value(U128(0)),
            Err(reason) => {
                JobEvent::PostRefunded {
                    sender_id: &sender_id,
                    amount,
                    reason,
                }
                .emit();
                PromiseOrValue::Value(amount)
            }
        }
    }

    /// The client, or the operator when the job was posted with `auto_award`. No deposit. The
    /// difference between budget and price goes back to the client at once.
    pub fn award(&mut self, job_id: u64, agent_id: AccountId, price: U128) {
        let mut job = self.load(job_id);
        let caller = env::predecessor_account_id();
        require!(
            caller == job.client_id || (job.auto_award && caller == self.operator_id),
            "not_client"
        );
        require!(job.status == JobStatus::Open, "wrong_status");
        require!(is_agent_wallet(&agent_id, &self.registry_id), "not_agent");
        require!(price.0 > 0 && price.0 <= job.budget.0, "invalid_price");
        let change = job.budget.0 - price.0;
        job.status = JobStatus::Awarded;
        job.agent_id = Some(agent_id.clone());
        job.awarded_at_ms = Some(env::block_timestamp_ms());
        job.price = Some(price);
        JobEvent::JobAwarded {
            job_id,
            agent_id: &agent_id,
            price,
        }
        .emit();
        if change > 0 {
            let refund = Transfer {
                receiver_id: job.client_id.clone(),
                amount: U128(change),
                purpose: Purpose::Refund,
            };
            self.send(&mut job, vec![refund]);
        }
        self.jobs.insert(job_id, job);
    }

    /// Operator only, no deposit.
    pub fn deliver(&mut self, job_id: u64, agent_id: AccountId, work_hash: String) {
        require!(
            env::predecessor_account_id() == self.operator_id,
            "not_operator"
        );
        require!(
            !work_hash.is_empty() && work_hash.len() <= MAX_HASH_LEN,
            "invalid_hash"
        );
        let mut job = self.load(job_id);
        require!(job.status == JobStatus::Awarded, "wrong_status");
        require!(job.agent_id.as_ref() == Some(&agent_id), "wrong_agent");
        job.status = JobStatus::Delivered;
        job.delivered_at_ms = Some(env::block_timestamp_ms());
        JobEvent::JobDelivered {
            job_id,
            agent_id: &agent_id,
            work_hash: &work_hash,
        }
        .emit();
        job.work_hash = Some(work_hash);
        self.jobs.insert(job_id, job);
    }

    /// The client, no deposit, rating 1..=5. Pays the agent wallet.
    pub fn accept(&mut self, job_id: u64, rating: u8) {
        require!((1..=5).contains(&rating), "invalid_rating");
        let job = self.load(job_id);
        require!(env::predecessor_account_id() == job.client_id, "not_client");
        require!(job.status == JobStatus::Delivered, "wrong_status");
        self.pay_agent(job, RepOutcome::Completed, Some(rating));
    }

    /// Anyone, no deposit, once the review window after delivery has passed: accepts with rating 4.
    pub fn release_expired(&mut self, job_id: u64) {
        let job = self.load(job_id);
        require!(job.status == JobStatus::Delivered, "wrong_status");
        require!(!review_open(&job), "review_window_open");
        self.pay_agent(job, RepOutcome::Completed, Some(EXPIRED_RATING));
    }

    /// The client, no deposit, after delivery and while the review window is open.
    pub fn dispute(&mut self, job_id: u64) {
        let mut job = self.load(job_id);
        require!(env::predecessor_account_id() == job.client_id, "not_client");
        require!(job.status == JobStatus::Delivered, "wrong_status");
        require!(review_open(&job), "review_window_closed");
        job.status = JobStatus::Disputed;
        JobEvent::JobDisputed { job_id }.emit();
        self.jobs.insert(job_id, job);
    }

    /// Operator only (the arbiter), no deposit: refund the client or pay the agent.
    pub fn resolve(&mut self, job_id: u64, refund: bool) {
        require!(
            env::predecessor_account_id() == self.operator_id,
            "not_operator"
        );
        let job = self.load(job_id);
        require!(job.status == JobStatus::Disputed, "wrong_status");
        if !refund {
            self.pay_agent(job, RepOutcome::DisputeWon, None);
            return;
        }
        let agent_id = job
            .agent_id
            .clone()
            .unwrap_or_else(|| env::panic_str("no_agent"));
        let transfers = vec![Transfer {
            receiver_id: job.client_id.clone(),
            amount: job.price.unwrap_or(U128(0)),
            purpose: Purpose::Refund,
        }];
        self.record_reputation(&agent_id, job_id, RepOutcome::DisputeLost, None);
        self.settle(job, Settlement::Refunded, None, transfers);
    }

    /// The client, no deposit, before award: the whole budget goes back.
    pub fn cancel(&mut self, job_id: u64) {
        let job = self.load(job_id);
        require!(env::predecessor_account_id() == job.client_id, "not_client");
        require!(job.status == JobStatus::Open, "wrong_status");
        let transfers = vec![Transfer {
            receiver_id: job.client_id.clone(),
            amount: job.budget,
            purpose: Purpose::Refund,
        }];
        self.settle(job, Settlement::Cancelled, None, transfers);
    }

    /// Anyone, no deposit; always pays the client. Once the delivery window after award has passed
    /// without a delivery, the price held in escrow goes back to the client. Nothing is recorded to
    /// reputation: the agent may not exist (awards only check the account id's shape).
    pub fn reclaim_undelivered(&mut self, job_id: u64) {
        let job = self.load(job_id);
        require!(job.status == JobStatus::Awarded, "wrong_status");
        let deadline = job
            .awarded_at_ms
            .unwrap_or(0)
            .saturating_add(job.delivery_window_ms);
        require!(
            env::block_timestamp_ms() >= deadline,
            "delivery_window_open"
        );
        let transfers = vec![Transfer {
            receiver_id: job.client_id.clone(),
            amount: job.price.unwrap_or(U128(0)),
            purpose: Purpose::Refund,
        }];
        self.settle(job, Settlement::Reclaimed, None, transfers);
    }

    /// Anyone, no deposit; always pays the client. If the agent's payout is still failing one
    /// delivery window after settlement (for example, the award named an agent-shaped account that
    /// does not exist or is not registered on the token), the owed payout is redirected to the client.
    /// Until then anyone can fix the cause and call `retry_payout`. A failed fee stays owed to the
    /// treasury.
    pub fn reclaim_failed_payout(&mut self, job_id: u64) {
        let mut job = self.load(job_id);
        require!(job.status == JobStatus::PayoutFailed, "wrong_status");
        let deadline = job
            .settled_at_ms
            .unwrap_or(0)
            .saturating_add(job.delivery_window_ms);
        require!(env::block_timestamp_ms() >= deadline, "payout_window_open");
        require!(
            job.owed.iter().any(|t| t.purpose == Purpose::AgentPayout),
            "nothing_to_reclaim"
        );
        let transfers: Vec<Transfer> = std::mem::take(&mut job.owed)
            .into_iter()
            .map(|t| match t.purpose {
                Purpose::AgentPayout => Transfer {
                    receiver_id: job.client_id.clone(),
                    amount: t.amount,
                    purpose: Purpose::Refund,
                },
                _ => t,
            })
            .collect();
        job.status = JobStatus::Settling;
        job.settlement = Some(Settlement::Reclaimed);
        JobEvent::JobSettling {
            job_id,
            settlement: Settlement::Reclaimed,
            rating: None,
            transfers: &transfers,
        }
        .emit();
        self.send(&mut job, transfers);
        self.jobs.insert(job_id, job);
    }

    /// Anyone, no deposit. Resends every transfer of the job that failed. Each goes to the receiver
    /// fixed at settlement, so the caller cannot redirect money.
    pub fn retry_payout(&mut self, job_id: u64) {
        let mut job = self.load(job_id);
        require!(!job.owed.is_empty(), "nothing_owed");
        let owed = std::mem::take(&mut job.owed);
        if job.status == JobStatus::PayoutFailed {
            job.status = JobStatus::Settling;
        }
        self.send(&mut job, owed);
        self.jobs.insert(job_id, job);
    }

    /// Resolves one transfer out of escrow. A failed transfer is kept as owed; a settled job with
    /// nothing in flight and nothing owed is removed.
    #[private]
    pub fn on_payout(&mut self, job_id: u64, transfer: Transfer) {
        let Some(mut job) = self.jobs.get(&job_id).cloned() else {
            // Jobs are only removed once nothing is in flight, so this cannot happen; ignore rather
            // than panic so a stray callback cannot fail.
            return;
        };
        job.in_flight = job.in_flight.saturating_sub(1);
        if promise_succeeded(0) {
            job.escrow = U128(job.escrow.0.saturating_sub(transfer.amount.0));
        } else {
            JobEvent::PayoutFailed {
                job_id,
                transfer: &transfer,
            }
            .emit();
            job.owed.push(transfer);
        }
        let settled = matches!(job.status, JobStatus::Settling | JobStatus::PayoutFailed);
        if settled && job.in_flight == 0 {
            if job.owed.is_empty() {
                self.remove(job);
                return;
            }
            job.status = JobStatus::PayoutFailed;
        }
        self.jobs.insert(job_id, job);
    }

    pub fn get_job(&self, job_id: u64) -> Option<Job> {
        self.jobs.get(&job_id).cloned()
    }

    pub fn get_job_by_key(&self, job_key: String) -> Option<Job> {
        self.job_keys
            .get(&job_key)
            .and_then(|id| self.jobs.get(id))
            .cloned()
    }

    /// True while the key belongs to a live job or one of the last `SETTLED_KEY_MEMORY` settled
    /// jobs; such a key is refused on post.
    pub fn is_job_key_used(&self, job_key: String) -> bool {
        self.job_keys.contains_key(&job_key) || self.settled_keys.contains_key(&job_key)
    }

    pub fn get_jobs(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Job> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize;
        self.jobs.values().skip(from).take(limit).cloned().collect()
    }

    pub fn get_job_count(&self) -> u32 {
        self.jobs.len()
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner_id: self.owner_id.clone(),
            operator_id: self.operator_id.clone(),
            credits_id: self.credits_id.clone(),
            registry_id: self.registry_id.clone(),
            rep_id: self.rep_id.clone(),
            treasury_id: self.treasury_id.clone(),
            fee_bps: self.fee_bps,
            min_budget: U128(MIN_BUDGET),
        }
    }
}

impl JobBoard {
    fn post(&mut self, client_id: &AccountId, amount: u128, msg: &str) -> Result<(), &'static str> {
        let TransferMsg::Post(args) =
            serde_json::from_str::<TransferMsg>(msg).map_err(|_| "invalid_msg")?;
        if amount < MIN_BUDGET {
            return Err("below_min_budget");
        }
        if amount > MAX_AMOUNT {
            return Err("amount_too_large");
        }
        if args.job_key.is_empty() || args.job_key.len() > MAX_JOB_KEY_LEN {
            return Err("invalid_job_key");
        }
        if args.spec_hash.is_empty() || args.spec_hash.len() > MAX_HASH_LEN {
            return Err("invalid_hash");
        }
        if args.review_window_ms > MAX_REVIEW_WINDOW_MS {
            return Err("invalid_review_window");
        }
        let delivery_window_ms = args
            .delivery_window_ms
            .unwrap_or(DEFAULT_DELIVERY_WINDOW_MS);
        if !(MIN_DELIVERY_WINDOW_MS..=MAX_DELIVERY_WINDOW_MS).contains(&delivery_window_ms) {
            return Err("invalid_delivery_window");
        }
        if self.is_job_key_used(args.job_key.clone()) {
            return Err("duplicate_job_key");
        }
        let job_id = self.next_job_id;
        self.next_job_id += 1;
        let job = Job {
            job_id,
            job_key: args.job_key,
            client_id: client_id.clone(),
            spec_hash: args.spec_hash,
            auto_award: args.auto_award,
            review_window_ms: args.review_window_ms,
            delivery_window_ms,
            budget: U128(amount),
            escrow: U128(amount),
            status: JobStatus::Open,
            agent_id: None,
            price: None,
            work_hash: None,
            posted_at_ms: env::block_timestamp_ms(),
            awarded_at_ms: None,
            delivered_at_ms: None,
            settled_at_ms: None,
            settlement: None,
            owed: Vec::new(),
            in_flight: 0,
        };
        JobEvent::JobPosted {
            job_id,
            job_key: &job.job_key,
            client_id,
            budget: job.budget,
            auto_award: job.auto_award,
        }
        .emit();
        self.job_keys.insert(job.job_key.clone(), job_id);
        self.jobs.insert(job_id, job);
        Ok(())
    }

    fn load(&self, job_id: u64) -> Job {
        self.jobs
            .get(&job_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("not_found"))
    }

    /// Pays `price - fee` to the agent wallet and the fee (rounded down) to the treasury.
    fn pay_agent(&mut self, job: Job, outcome: RepOutcome, rating: Option<u8>) {
        let agent_id = job
            .agent_id
            .clone()
            .unwrap_or_else(|| env::panic_str("no_agent"));
        let price = job.price.unwrap_or_else(|| env::panic_str("no_price")).0;
        let fee = platform_fee(price, self.fee_bps);
        let mut transfers = vec![Transfer {
            receiver_id: agent_id.clone(),
            amount: U128(price - fee),
            purpose: Purpose::AgentPayout,
        }];
        if fee > 0 {
            transfers.push(Transfer {
                receiver_id: self.treasury_id.clone(),
                amount: U128(fee),
                purpose: Purpose::Fee,
            });
        }
        self.record_reputation(&agent_id, job.job_id, outcome, rating);
        self.settle(job, Settlement::Paid, rating, transfers);
    }

    fn settle(
        &mut self,
        mut job: Job,
        settlement: Settlement,
        rating: Option<u8>,
        transfers: Vec<Transfer>,
    ) {
        job.status = JobStatus::Settling;
        job.settlement = Some(settlement);
        job.settled_at_ms = Some(env::block_timestamp_ms());
        JobEvent::JobSettling {
            job_id: job.job_id,
            settlement,
            rating,
            transfers: &transfers,
        }
        .emit();
        self.send(&mut job, transfers);
        self.jobs.insert(job.job_id, job);
    }

    /// One `ft_transfer` per item, each with its own callback so a failure is tracked per receiver.
    fn send(&self, job: &mut Job, transfers: Vec<Transfer>) {
        for transfer in transfers {
            if transfer.amount.0 == 0 {
                continue;
            }
            job.in_flight += 1;
            ext_ft::ext(self.credits_id.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_FOR_FT_TRANSFER)
                .ft_transfer(
                    transfer.receiver_id.clone(),
                    transfer.amount,
                    Some(format!("job {}", job.job_id)),
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_FOR_PAYOUT_CALLBACK)
                        .on_payout(job.job_id, transfer),
                )
                .detach();
        }
    }

    /// Fire-and-forget: reputation is a record of the outcome, not a condition of payment.
    fn record_reputation(
        &self,
        agent_id: &AccountId,
        job_id: u64,
        outcome: RepOutcome,
        rating: Option<u8>,
    ) {
        ext_rep::ext(self.rep_id.clone())
            .with_static_gas(GAS_FOR_REP_RECORD)
            .record(agent_id.clone(), job_id.to_string(), outcome, rating)
            .detach();
    }

    fn remove(&mut self, job: Job) {
        self.jobs.remove(&job.job_id);
        self.job_keys.remove(&job.job_key);
        self.remember_settled_key(job.job_key.clone());
        JobEvent::JobSettled {
            job_id: job.job_id,
            job_key: &job.job_key,
            settlement: job.settlement.unwrap_or(Settlement::Paid),
        }
        .emit();
    }

    fn remember_settled_key(&mut self, job_key: String) {
        let slot = self.settled_cursor;
        if slot < self.settled_ring.len() {
            let evicted = std::mem::replace(&mut self.settled_ring[slot], job_key.clone());
            if self.settled_keys.get(&evicted) == Some(&slot) {
                self.settled_keys.remove(&evicted);
            }
        } else {
            self.settled_ring.push(job_key.clone());
        }
        self.settled_keys.insert(job_key, slot);
        self.settled_cursor = (slot + 1) % SETTLED_KEY_MEMORY;
    }
}

/// The platform's cut, rounded down so the agent keeps the remainder.
pub fn platform_fee(price: u128, fee_bps: u16) -> u128 {
    price * u128::from(fee_bps) / BPS_DENOMINATOR
}

fn review_open(job: &Job) -> bool {
    let delivered = job.delivered_at_ms.unwrap_or(0);
    env::block_timestamp_ms() < delivered.saturating_add(job.review_window_ms)
}

#[cfg(test)]
mod tests {
    use super::platform_fee;

    #[test]
    fn the_platform_fee_rounds_down() {
        assert_eq!(platform_fee(1_000_001, 500), 50_000);
        assert_eq!(platform_fee(19, 500), 0);
        assert_eq!(platform_fee(1_000_000, 0), 0);
    }
}
