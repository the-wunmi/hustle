//! Agent wallet: a keyless sub-account of the registry that holds one agent's credits and enforces
//! its owner's rulebook against the game's operator.
//!
//! Storage: all state lives in one bounded struct (rings and queues have fixed caps, strings have
//! length caps), paid from the NEAR the registry transfers in at creation. Nothing a caller does can
//! grow it past `MAX_WALLET_STATE_BYTES`.

use std::collections::VecDeque;

use hustle_common::{
    ext_ft, is_agent_wallet, promise_succeeded, Rulebook, GAS_FOR_FT_TRANSFER, MAX_AMOUNT,
};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, PromiseOrValue};

/// Most approval requests waiting for the owner. Eight is more than a day of exceptions for one
/// agent and keeps the wallet's state small; when full, further over-cap spends are blocked.
pub const MAX_PENDING: usize = 8;

/// Request keys remembered for idempotency. 64 covers the engine's reconcile horizon (it settles
/// in-doubt calls within a few game turns) while bounding state.
pub const RECENT_OUTCOMES: usize = 64;

/// Jobs whose spend is tracked for `max_per_job`. An agent works one job at a time; 16 leaves room
/// for overlapping and retried jobs. The oldest entry is dropped when a 17th job appears.
pub const JOB_SPEND_SLOTS: usize = 16;

/// Longest idempotency key: enough for a job id plus a stage name plus a counter.
pub const MAX_KEY_LEN: usize = 64;

/// Longest job id a spend may be attributed to (the job board's ids and keys fit easily).
pub const MAX_JOB_ID_LEN: usize = 64;

/// Longest memo forwarded to `ft_transfer`; a short human note, not a document.
pub const MAX_MEMO_LEN: usize = 128;

/// Longest receipt (a hex or base58 hash of the provider's signed response, with a prefix).
pub const MAX_RECEIPT_LEN: usize = 128;

/// Upper bound on this contract's state with every ring and queue full and every string at its cap.
/// The registry funds each wallet for this many bytes plus its code.
pub const MAX_WALLET_STATE_BYTES: u64 = 24_000;

/// Shortest accepted length of a spending "day". The game compresses days to a few real minutes;
/// one minute is well above block time (about a second), so a day always spans many blocks and the
/// daily cap cannot be dodged by a reset every block.
pub const MIN_DAY_MS: u64 = 60_000;

/// Gas reserved for `on_spend_settled` / `on_withdrawn`.
const GAS_FOR_SETTLE_CALLBACK: Gas = Gas::from_tgas(15);

const ITEM_SPEC: &str = "sharded-item-1.0.0";

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpendKind {
    Inference,
    Tool,
    Helper,
    Upkeep,
    /// Collateral for a contract job: held by the treasury, returned with the payout, paid to the
    /// client if the arbiter refunds them. Not a purchase, so only the daily cap applies.
    Bond,
}

impl SpendKind {
    /// Inference, upkeep and bonds are paid to the treasury and are never held for the owner's
    /// approval: over a cap they are blocked.
    fn is_metered(self) -> bool {
        matches!(
            self,
            SpendKind::Inference | SpendKind::Upkeep | SpendKind::Bond
        )
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SpendRequest {
    /// Idempotency key: a repeated key returns the stored outcome without moving money.
    pub key: String,
    pub kind: SpendKind,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub job_id: Option<String>,
    pub memo: String,
    pub receipt: Option<String>,
}

impl SpendRequest {
    fn assert_valid(&self) {
        require!(
            !self.key.is_empty() && self.key.len() <= MAX_KEY_LEN,
            "invalid_key"
        );
        require!(
            self.amount.0 > 0 && self.amount.0 <= MAX_AMOUNT,
            "invalid_amount"
        );
        require!(self.memo.len() <= MAX_MEMO_LEN, "memo_too_long");
        if let Some(job_id) = &self.job_id {
            require!(
                !job_id.is_empty() && job_id.len() <= MAX_JOB_ID_LEN,
                "invalid_job_id"
            );
        }
        if let Some(receipt) = &self.receipt {
            require!(receipt.len() <= MAX_RECEIPT_LEN, "receipt_too_long");
        }
    }
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpendStatus {
    /// Credits moved to the receiver.
    Settled,
    /// Refused by the rulebook; nothing moved.
    Blocked,
    /// Waiting for the owner's approval.
    Pending,
    /// The transfer was sent and its result has not come back yet.
    InFlight,
    /// The transfer failed; the reservation was released and nothing moved.
    Failed,
    /// The owner denied the approval, or a change of owner cleared it.
    Denied,
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Frozen,
    VendorNotAllowed,
    HiringDisabled,
    SelfPayment,
    OverCallCap,
    OverJobCap,
    OverDailyCap,
    OverHelperBudget,
    ApprovalQueueFull,
    TransferFailed,
    DeniedByOwner,
    OwnerChanged,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpendOutcome {
    pub status: SpendStatus,
    pub request_id: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reason: Option<Reason>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct PendingApproval {
    pub request_id: u64,
    pub request: SpendRequest,
    /// Which cap the request exceeded.
    pub reason: Reason,
    pub requested_at_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct RecentOutcome {
    pub key: String,
    pub outcome: SpendOutcome,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct JobSpend {
    pub job_id: String,
    pub spent: U128,
}

#[near(serializers = [json])]
pub struct ItemInfo {
    pub spec: String,
    pub collection_id: AccountId,
    pub token_id: AccountId,
    pub owner_id: AccountId,
    pub rotation_seq: u64,
}

/// NEP-297 events, standard `hustle`.
#[near(event_json(standard = "hustle"))]
pub enum WalletEvent<'a> {
    #[event_version("1.0.0")]
    SpendSettled {
        request_id: u64,
        key: &'a str,
        kind: SpendKind,
        receiver_id: &'a AccountId,
        amount: U128,
        job_id: Option<&'a str>,
        receipt: Option<&'a str>,
    },
    #[event_version("1.0.0")]
    SpendBlocked {
        request_id: u64,
        key: &'a str,
        kind: SpendKind,
        receiver_id: &'a AccountId,
        amount: U128,
        job_id: Option<&'a str>,
        reason: Reason,
    },
    #[event_version("1.0.0")]
    ApprovalRequested {
        request_id: u64,
        key: &'a str,
        kind: SpendKind,
        receiver_id: &'a AccountId,
        amount: U128,
        job_id: Option<&'a str>,
        reason: Reason,
    },
    #[event_version("1.0.0")]
    ApprovalDenied {
        request_id: u64,
        key: &'a str,
        reason: Reason,
    },
    #[event_version("1.0.0")]
    SpendFailed {
        request_id: u64,
        key: &'a str,
        kind: SpendKind,
        receiver_id: &'a AccountId,
        amount: U128,
        job_id: Option<&'a str>,
        reason: Reason,
    },
    #[event_version("1.0.0")]
    RulebookSet { rulebook: &'a Rulebook },
    #[event_version("1.0.0")]
    FrozenSet { frozen: bool },
    #[event_version("1.0.0")]
    Withdrawn {
        receiver_id: &'a AccountId,
        amount: U128,
    },
    #[event_version("1.0.0")]
    WithdrawFailed {
        receiver_id: &'a AccountId,
        amount: U128,
    },
    /// `frozen` is always true: a new owner unfreezes explicitly once they have checked the rulebook.
    #[event_version("1.1.0")]
    OwnerRotated {
        old_owner_id: &'a AccountId,
        new_owner_id: &'a AccountId,
        rotation_seq: u64,
        cleared_request_ids: Vec<u64>,
        frozen: bool,
    },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AgentWallet {
    owner_id: AccountId,
    registry_id: AccountId,
    operator_id: AccountId,
    credits_id: AccountId,
    jobs_id: AccountId,
    treasury_id: AccountId,
    rulebook: Rulebook,
    frozen: bool,
    /// Day index (`block_timestamp_ms / day_ms`) that `spent_today` belongs to.
    day: u64,
    spent_today: u128,
    job_spend: VecDeque<JobSpend>,
    pending: Vec<PendingApproval>,
    recent: VecDeque<RecentOutcome>,
    rotation_seq: u64,
    next_request_id: u64,
    /// Length of a spending day in milliseconds (86_400_000 for real UTC days).
    day_ms: u64,
}

/// Everything in the wallet's state, for the game and the owner's UI.
#[near(serializers = [json])]
pub struct WalletView {
    pub account_id: AccountId,
    pub owner_id: AccountId,
    pub registry_id: AccountId,
    pub operator_id: AccountId,
    pub credits_id: AccountId,
    pub jobs_id: AccountId,
    pub treasury_id: AccountId,
    pub rulebook: Rulebook,
    pub frozen: bool,
    pub day: u64,
    pub spent_today: U128,
    pub job_spend: Vec<JobSpend>,
    pub pending: Vec<PendingApproval>,
    pub recent: Vec<RecentOutcome>,
    pub rotation_seq: u64,
    pub next_request_id: u64,
    pub day_ms: u64,
}

#[near]
impl AgentWallet {
    /// Called by the registry in the same batch that creates this account, so nobody else can
    /// initialise it first.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner_id: AccountId,
        operator_id: AccountId,
        credits_id: AccountId,
        jobs_id: AccountId,
        treasury_id: AccountId,
        rulebook: Option<Rulebook>,
        day_ms: u64,
    ) -> Self {
        let registry_id = env::predecessor_account_id();
        require!(
            is_agent_wallet(&env::current_account_id(), &registry_id),
            "not_registry"
        );
        require!(day_ms >= MIN_DAY_MS, "invalid_day_ms");
        let rulebook = rulebook.unwrap_or_else(Rulebook::locked);
        rulebook.assert_valid();
        Self {
            owner_id,
            registry_id,
            operator_id,
            credits_id,
            jobs_id,
            treasury_id,
            rulebook,
            frozen: false,
            day: env::block_timestamp_ms() / day_ms,
            spent_today: 0,
            job_spend: VecDeque::new(),
            pending: Vec::new(),
            recent: VecDeque::new(),
            rotation_seq: 0,
            next_request_id: 0,
            day_ms,
        }
    }

    /// Operator only, no deposit. Applies the rulebook to one payment. Blocked and pending outcomes
    /// return normally (no panic) so their event stays on-chain as evidence.
    pub fn spend(&mut self, request: SpendRequest) -> PromiseOrValue<SpendOutcome> {
        require!(
            env::predecessor_account_id() == self.operator_id,
            "not_operator"
        );
        request.assert_valid();
        if let Some(previous) = self.find_recent(&request.key) {
            return PromiseOrValue::Value(previous.outcome);
        }
        self.roll_day();
        let request_id = self.take_request_id();

        if self.frozen {
            return PromiseOrValue::Value(self.block(&request, request_id, Reason::Frozen));
        }
        if let Some(reason) = self.receiver_rule(&request) {
            return PromiseOrValue::Value(self.block(&request, request_id, reason));
        }
        if let Some(reason) = self.cap_breach(&request) {
            if request.kind.is_metered() {
                return PromiseOrValue::Value(self.block(&request, request_id, reason));
            }
            if self.pending.len() >= MAX_PENDING {
                return PromiseOrValue::Value(self.block(
                    &request,
                    request_id,
                    Reason::ApprovalQueueFull,
                ));
            }
            return PromiseOrValue::Value(self.hold(request, request_id, reason));
        }
        self.execute(request, request_id)
    }

    /// Registry only (the registry checked the caller holds the NFT and attached 1 yocto). Executes
    /// a held request without the caps (the owner chose to exceed them) but still applies the frozen
    /// check and the receiver rule against the current rulebook.
    pub fn approve(&mut self, request_id: u64, rotation_seq: u64) -> PromiseOrValue<SpendOutcome> {
        self.assert_registry(rotation_seq);
        let approval = self.take_pending(request_id);
        self.roll_day();
        let request = approval.request;
        if self.frozen {
            return PromiseOrValue::Value(self.block(&request, request_id, Reason::Frozen));
        }
        if let Some(reason) = self.receiver_rule(&request) {
            return PromiseOrValue::Value(self.block(&request, request_id, reason));
        }
        self.execute(request, request_id)
    }

    /// Registry only. Drops a held request; nothing moves.
    pub fn deny(&mut self, request_id: u64, rotation_seq: u64) -> SpendOutcome {
        self.assert_registry(rotation_seq);
        let approval = self.take_pending(request_id);
        let outcome = SpendOutcome {
            status: SpendStatus::Denied,
            request_id,
            reason: Some(Reason::DeniedByOwner),
        };
        self.update_recent(&approval.request.key, outcome);
        WalletEvent::ApprovalDenied {
            request_id,
            key: &approval.request.key,
            reason: Reason::DeniedByOwner,
        }
        .emit();
        outcome
    }

    /// Registry only.
    pub fn set_rulebook(&mut self, rulebook: Rulebook, rotation_seq: u64) {
        self.assert_registry(rotation_seq);
        rulebook.assert_valid();
        self.rulebook = rulebook;
        WalletEvent::RulebookSet {
            rulebook: &self.rulebook,
        }
        .emit();
    }

    /// Registry only.
    pub fn set_frozen(&mut self, frozen: bool, rotation_seq: u64) {
        self.assert_registry(rotation_seq);
        self.frozen = frozen;
        WalletEvent::FrozenSet { frozen }.emit();
    }

    /// Registry only. The registry always passes the current NFT holder as `receiver_id`; a frozen
    /// wallet can still be withdrawn from.
    pub fn withdraw(
        &mut self,
        amount: U128,
        receiver_id: AccountId,
        rotation_seq: u64,
    ) -> near_sdk::Promise {
        self.assert_registry(rotation_seq);
        require!(amount.0 > 0 && amount.0 <= MAX_AMOUNT, "invalid_amount");
        ext_ft::ext(self.credits_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(receiver_id.clone(), amount, Some("withdraw".to_string()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_SETTLE_CALLBACK)
                    .on_withdrawn(receiver_id, amount),
            )
    }

    /// Registry only, after an NFT transfer. Out-of-order or repeated rotations (sequence not newer
    /// than the current one) are ignored, so the registry can safely resend. The wallet is frozen:
    /// the operator could otherwise spend under the seller's rulebook before the new owner has seen
    /// it, so nothing moves until the new owner unfreezes (`set_frozen(false)` via the registry).
    pub fn rotate_owner(&mut self, new_owner_id: AccountId, rotation_seq: u64) {
        require!(
            env::predecessor_account_id() == self.registry_id,
            "not_registry"
        );
        if rotation_seq <= self.rotation_seq {
            return;
        }
        let old_owner_id = std::mem::replace(&mut self.owner_id, new_owner_id);
        self.rotation_seq = rotation_seq;
        self.frozen = true;
        let cleared: Vec<PendingApproval> = std::mem::take(&mut self.pending);
        let cleared_request_ids = cleared.iter().map(|p| p.request_id).collect();
        for approval in &cleared {
            self.update_recent(
                &approval.request.key,
                SpendOutcome {
                    status: SpendStatus::Denied,
                    request_id: approval.request_id,
                    reason: Some(Reason::OwnerChanged),
                },
            );
        }
        WalletEvent::OwnerRotated {
            old_owner_id: &old_owner_id,
            new_owner_id: &self.owner_id,
            rotation_seq,
            cleared_request_ids,
            frozen: true,
        }
        .emit();
    }

    /// Resolves an `ft_transfer` started by `execute`: on failure the reservation against today and
    /// the job is released.
    #[private]
    pub fn on_spend_settled(
        &mut self,
        request: SpendRequest,
        request_id: u64,
        day: u64,
    ) -> SpendOutcome {
        let job_id = request.job_id.as_deref();
        let outcome = if promise_succeeded(0) {
            WalletEvent::SpendSettled {
                request_id,
                key: &request.key,
                kind: request.kind,
                receiver_id: &request.receiver_id,
                amount: request.amount,
                job_id,
                receipt: request.receipt.as_deref(),
            }
            .emit();
            SpendOutcome {
                status: SpendStatus::Settled,
                request_id,
                reason: None,
            }
        } else {
            self.release(&request, day);
            WalletEvent::SpendFailed {
                request_id,
                key: &request.key,
                kind: request.kind,
                receiver_id: &request.receiver_id,
                amount: request.amount,
                job_id,
                reason: Reason::TransferFailed,
            }
            .emit();
            SpendOutcome {
                status: SpendStatus::Failed,
                request_id,
                reason: Some(Reason::TransferFailed),
            }
        };
        self.update_recent(&request.key, outcome);
        outcome
    }

    #[private]
    pub fn on_withdrawn(&mut self, receiver_id: AccountId, amount: U128) -> bool {
        let ok = promise_succeeded(0);
        if ok {
            WalletEvent::Withdrawn {
                receiver_id: &receiver_id,
                amount,
            }
            .emit();
        } else {
            WalletEvent::WithdrawFailed {
                receiver_id: &receiver_id,
                amount,
            }
            .emit();
        }
        ok
    }

    pub fn get_wallet(&self) -> WalletView {
        WalletView {
            account_id: env::current_account_id(),
            owner_id: self.owner_id.clone(),
            registry_id: self.registry_id.clone(),
            operator_id: self.operator_id.clone(),
            credits_id: self.credits_id.clone(),
            jobs_id: self.jobs_id.clone(),
            treasury_id: self.treasury_id.clone(),
            rulebook: self.rulebook.clone(),
            frozen: self.frozen,
            day: self.day,
            spent_today: U128(self.spent_today_now()),
            job_spend: self.job_spend.iter().cloned().collect(),
            pending: self.pending.clone(),
            recent: self.recent.iter().cloned().collect(),
            rotation_seq: self.rotation_seq,
            next_request_id: self.next_request_id,
            day_ms: self.day_ms,
        }
    }

    /// The stored outcome for an idempotency key, while it is still in the recent ring.
    pub fn get_outcome(&self, key: String) -> Option<SpendOutcome> {
        self.find_recent(&key).map(|r| r.outcome)
    }

    pub fn nft_item_info(&self) -> ItemInfo {
        ItemInfo {
            spec: ITEM_SPEC.to_string(),
            collection_id: self.registry_id.clone(),
            token_id: env::current_account_id(),
            owner_id: self.owner_id.clone(),
            rotation_seq: self.rotation_seq,
        }
    }
}

impl AgentWallet {
    /// Owner actions come through the registry with the rotation sequence it holds for the token. A
    /// mismatch means the NFT changed hands after the registry checked ownership (or before this
    /// wallet heard about it), so the action is refused rather than applied for the wrong owner.
    fn assert_registry(&self, rotation_seq: u64) {
        require!(
            env::predecessor_account_id() == self.registry_id,
            "not_registry"
        );
        require!(rotation_seq == self.rotation_seq, "stale_owner");
    }

    fn take_request_id(&mut self) -> u64 {
        let id = self.next_request_id;
        self.next_request_id += 1;
        id
    }

    fn today(&self) -> u64 {
        env::block_timestamp_ms() / self.day_ms
    }

    fn roll_day(&mut self) {
        let day = self.today();
        if day != self.day {
            self.day = day;
            self.spent_today = 0;
        }
    }

    fn spent_today_now(&self) -> u128 {
        if self.today() == self.day {
            self.spent_today
        } else {
            0
        }
    }

    fn receiver_rule(&self, request: &SpendRequest) -> Option<Reason> {
        let receiver = &request.receiver_id;
        match request.kind {
            SpendKind::Inference | SpendKind::Upkeep | SpendKind::Bond => {
                (receiver != &self.treasury_id).then_some(Reason::VendorNotAllowed)
            }
            SpendKind::Tool => {
                let allowed =
                    self.rulebook.any_vendor || self.rulebook.allowed_vendors.contains(receiver);
                (!allowed).then_some(Reason::VendorNotAllowed)
            }
            SpendKind::Helper => {
                if !self.rulebook.may_hire {
                    Some(Reason::HiringDisabled)
                } else if !is_agent_wallet(receiver, &self.registry_id) {
                    Some(Reason::VendorNotAllowed)
                } else if receiver == &env::current_account_id() {
                    Some(Reason::SelfPayment)
                } else {
                    None
                }
            }
        }
    }

    fn cap_breach(&self, request: &SpendRequest) -> Option<Reason> {
        let amount = request.amount.0;
        let rules = &self.rulebook;
        if request.kind == SpendKind::Bond {
            // A bond buys nothing; it only counts against what may leave the wallet today.
            return (self.spent_today + amount > rules.daily_cap.0).then_some(Reason::OverDailyCap);
        }
        if amount > rules.max_per_call.0 {
            return Some(Reason::OverCallCap);
        }
        if let Some(job_id) = &request.job_id {
            if self.job_spent(job_id) + amount > rules.max_per_job.0 {
                return Some(Reason::OverJobCap);
            }
        }
        if self.spent_today + amount > rules.daily_cap.0 {
            return Some(Reason::OverDailyCap);
        }
        if request.kind == SpendKind::Helper && amount > rules.helper_budget.0 {
            return Some(Reason::OverHelperBudget);
        }
        None
    }

    fn job_spent(&self, job_id: &str) -> u128 {
        self.job_spend
            .iter()
            .find(|j| j.job_id == job_id)
            .map_or(0, |j| j.spent.0)
    }

    /// Reserves the amount against today and the job, then sends the transfer.
    fn execute(&mut self, request: SpendRequest, request_id: u64) -> PromiseOrValue<SpendOutcome> {
        let amount = request.amount.0;
        self.spent_today += amount;
        if let Some(job_id) = request
            .job_id
            .as_ref()
            .filter(|_| request.kind != SpendKind::Bond)
        {
            self.add_job_spend(job_id, amount);
        }
        self.record(
            &request.key,
            SpendOutcome {
                status: SpendStatus::InFlight,
                request_id,
                reason: None,
            },
        );
        let memo = (!request.memo.is_empty()).then(|| request.memo.clone());
        ext_ft::ext(self.credits_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(request.receiver_id.clone(), request.amount, memo)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_SETTLE_CALLBACK)
                    .on_spend_settled(request, request_id, self.day),
            )
            .into()
    }

    fn add_job_spend(&mut self, job_id: &str, amount: u128) {
        if let Some(entry) = self.job_spend.iter_mut().find(|j| j.job_id == job_id) {
            entry.spent = U128(entry.spent.0 + amount);
            return;
        }
        if self.job_spend.len() >= JOB_SPEND_SLOTS {
            self.job_spend.pop_front();
        }
        self.job_spend.push_back(JobSpend {
            job_id: job_id.to_string(),
            spent: U128(amount),
        });
    }

    /// Undoes `execute`'s reservation. If the day rolled over since, today's total no longer holds
    /// the amount and is left alone.
    fn release(&mut self, request: &SpendRequest, day: u64) {
        let amount = request.amount.0;
        if self.day == day {
            self.spent_today = self.spent_today.saturating_sub(amount);
        }
        if let Some(job_id) = request
            .job_id
            .as_ref()
            .filter(|_| request.kind != SpendKind::Bond)
        {
            if let Some(entry) = self.job_spend.iter_mut().find(|j| &j.job_id == job_id) {
                entry.spent = U128(entry.spent.0.saturating_sub(amount));
            }
        }
    }

    fn block(&mut self, request: &SpendRequest, request_id: u64, reason: Reason) -> SpendOutcome {
        WalletEvent::SpendBlocked {
            request_id,
            key: &request.key,
            kind: request.kind,
            receiver_id: &request.receiver_id,
            amount: request.amount,
            job_id: request.job_id.as_deref(),
            reason,
        }
        .emit();
        let outcome = SpendOutcome {
            status: SpendStatus::Blocked,
            request_id,
            reason: Some(reason),
        };
        self.record(&request.key, outcome);
        outcome
    }

    fn hold(&mut self, request: SpendRequest, request_id: u64, reason: Reason) -> SpendOutcome {
        WalletEvent::ApprovalRequested {
            request_id,
            key: &request.key,
            kind: request.kind,
            receiver_id: &request.receiver_id,
            amount: request.amount,
            job_id: request.job_id.as_deref(),
            reason,
        }
        .emit();
        let outcome = SpendOutcome {
            status: SpendStatus::Pending,
            request_id,
            reason: Some(reason),
        };
        self.record(&request.key, outcome);
        self.pending.push(PendingApproval {
            request_id,
            request,
            reason,
            requested_at_ms: env::block_timestamp_ms(),
        });
        outcome
    }

    fn take_pending(&mut self, request_id: u64) -> PendingApproval {
        let index = self
            .pending
            .iter()
            .position(|p| p.request_id == request_id)
            .unwrap_or_else(|| env::panic_str("not_found"));
        self.pending.remove(index)
    }

    fn find_recent(&self, key: &str) -> Option<&RecentOutcome> {
        self.recent.iter().find(|r| r.key == key)
    }

    /// Stores the outcome for a key. An approved request already has an entry (its `pending`
    /// outcome), so the entry is updated in place: one key, one entry, the latest outcome.
    fn record(&mut self, key: &str, outcome: SpendOutcome) {
        if let Some(entry) = self.recent.iter_mut().find(|r| r.key == key) {
            entry.outcome = outcome;
            return;
        }
        if self.recent.len() >= RECENT_OUTCOMES {
            self.recent.pop_front();
        }
        self.recent.push_back(RecentOutcome {
            key: key.to_string(),
            outcome,
        });
    }

    /// Later stages of a request (approval, settlement) update its entry if it is still remembered.
    fn update_recent(&mut self, key: &str, outcome: SpendOutcome) {
        if let Some(entry) = self.recent.iter_mut().find(|r| r.key == key) {
            entry.outcome = outcome;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::borsh;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn long_id(label: &str) -> AccountId {
        let suffix = ".agents.hustle.near";
        let pad = 64 - suffix.len() - label.len();
        format!("{label}{}{suffix}", "a".repeat(pad))
            .parse()
            .unwrap()
    }

    /// Fills every ring, queue and string to its cap and checks the borsh size stays under the bound
    /// the registry funds.
    #[test]
    fn a_full_wallet_fits_in_the_funded_state_bound() {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(id("agent-1.agents.hustle.near"))
            .predecessor_account_id(id("agents.hustle.near"));
        testing_env!(ctx.build());
        let max_amount = U128(u128::MAX);
        let mut wallet = AgentWallet::new(
            long_id("o"),
            long_id("p"),
            long_id("c"),
            long_id("j"),
            long_id("t"),
            None,
            86_400_000,
        );
        wallet.rulebook.allowed_vendors = (0..hustle_common::MAX_ALLOWED_VENDORS)
            .map(|i| long_id(&format!("v{i}")))
            .collect();
        let request = SpendRequest {
            key: "k".repeat(MAX_KEY_LEN),
            kind: SpendKind::Helper,
            receiver_id: long_id("r"),
            amount: max_amount,
            job_id: Some("j".repeat(MAX_JOB_ID_LEN)),
            memo: "m".repeat(MAX_MEMO_LEN),
            receipt: Some("x".repeat(MAX_RECEIPT_LEN)),
        };
        for i in 0..MAX_PENDING {
            wallet.pending.push(PendingApproval {
                request_id: u64::MAX - i as u64,
                request: request.clone(),
                reason: Reason::OverHelperBudget,
                requested_at_ms: u64::MAX,
            });
        }
        for _ in 0..RECENT_OUTCOMES {
            wallet.record(
                &request.key,
                SpendOutcome {
                    status: SpendStatus::Blocked,
                    request_id: u64::MAX,
                    reason: Some(Reason::OverHelperBudget),
                },
            );
        }
        for i in 0..JOB_SPEND_SLOTS {
            wallet.job_spend.push_back(JobSpend {
                job_id: format!("{i:0>64}"),
                spent: max_amount,
            });
        }
        let size = borsh::to_vec(&wallet).unwrap().len() as u64;
        // The state key and per-record overhead add 40 bytes per trie entry; one entry here.
        assert!(
            size + 40 + 8 < MAX_WALLET_STATE_BYTES,
            "wallet state {size} bytes exceeds bound"
        );
    }
}
