//! Reputation registry: job outcomes per agent, written by the job board, plus scam-blocked counts
//! written by the operator.
//!
//! Storage: one bounded entry per agent (counters plus the last `RECENT_OUTCOMES` outcomes, at most
//! `MAX_ENTRY_BYTES`). The job board creates entries from this contract's balance, but only after an
//! escrowed job of at least its minimum budget settles. The operator must attach
//! `new_entry_deposit` when its scam report creates an entry, so it cannot grow storage for free.

use std::collections::VecDeque;

use hustle_common::is_agent_wallet;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise,
};

/// Outcomes kept per agent for the UI's history strip. Twenty is a few game days of work and bounds
/// each entry to about 2 KB.
pub const RECENT_OUTCOMES: usize = 20;

/// Upper bound on one agent's stored entry (key, counters and a full ring of outcomes with
/// maximum-length job ids), checked by a unit test. A new entry from `record_scam_blocked` must pay
/// for this many bytes.
pub const MAX_ENTRY_BYTES: u64 = 2_400;

/// Longest job id stored with an outcome (the job board's numeric ids are far shorter).
pub const MAX_JOB_ID_LEN: usize = 64;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Agents,
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The client accepted (or the review window lapsed); carries a rating.
    Completed,
    /// A dispute the arbiter resolved in the agent's favour; unrated.
    DisputeWon,
    /// A dispute the arbiter resolved for the client (refund); unrated.
    DisputeLost,
    /// The operator saw the agent refuse an embedded scam instruction. Never changes the rating.
    ScamBlocked,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct OutcomeEntry {
    pub job_id: String,
    pub outcome: Outcome,
    pub rating: Option<u8>,
    pub at_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct Reputation {
    pub jobs_completed: u64,
    pub rating_sum: u64,
    pub rated_jobs: u64,
    pub disputes_lost: u64,
    pub scams_blocked: u64,
    pub recent: VecDeque<OutcomeEntry>,
}

#[near(event_json(standard = "hustle"))]
pub enum ReputationEvent<'a> {
    #[event_version("1.0.0")]
    OutcomeRecorded {
        agent_id: &'a AccountId,
        job_id: &'a str,
        outcome: Outcome,
        rating: Option<u8>,
    },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ReputationRegistry {
    owner_id: AccountId,
    jobs_id: AccountId,
    operator_id: AccountId,
    registry_id: AccountId,
    agents: LookupMap<AccountId, Reputation>,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner_id: AccountId,
    pub jobs_id: AccountId,
    pub operator_id: AccountId,
    pub registry_id: AccountId,
    /// Deposit `record_scam_blocked` needs when it creates an agent's entry, in yoctoNEAR.
    pub new_entry_deposit: NearToken,
}

#[near]
impl ReputationRegistry {
    #[init]
    pub fn new(
        owner_id: AccountId,
        jobs_id: AccountId,
        operator_id: AccountId,
        registry_id: AccountId,
    ) -> Self {
        Self {
            owner_id,
            jobs_id,
            operator_id,
            registry_id,
            agents: LookupMap::new(StorageKey::Agents),
        }
    }

    /// Job board only, no deposit. `rating` must be 1..=5 for `completed` and absent otherwise.
    pub fn record(
        &mut self,
        agent_id: AccountId,
        job_id: String,
        outcome: Outcome,
        rating: Option<u8>,
    ) {
        require!(env::predecessor_account_id() == self.jobs_id, "not_jobs");
        match outcome {
            Outcome::Completed => {
                require!(matches!(rating, Some(1..=5)), "invalid_rating")
            }
            Outcome::DisputeWon | Outcome::DisputeLost => {
                require!(rating.is_none(), "invalid_rating")
            }
            Outcome::ScamBlocked => env::panic_str("invalid_outcome"),
        }
        let entry = self.entry(&agent_id, &job_id);
        match outcome {
            Outcome::Completed | Outcome::DisputeWon => entry.jobs_completed += 1,
            Outcome::DisputeLost => entry.disputes_lost += 1,
            Outcome::ScamBlocked => {}
        }
        if let Some(rating) = rating {
            entry.rating_sum += u64::from(rating);
            entry.rated_jobs += 1;
        }
        push_recent(entry, job_id.clone(), outcome, rating);
        ReputationEvent::OutcomeRecorded {
            agent_id: &agent_id,
            job_id: &job_id,
            outcome,
            rating,
        }
        .emit();
    }

    /// Operator only. Only adds to the scam-blocked count, which never raises a rating. If the agent
    /// has no entry yet, the caller must attach `get_config().new_entry_deposit` to pay for it; any
    /// excess deposit is refunded.
    #[payable]
    pub fn record_scam_blocked(&mut self, agent_id: AccountId, job_id: String) {
        require!(
            env::predecessor_account_id() == self.operator_id,
            "not_operator"
        );
        let required = if self.agents.contains_key(&agent_id) {
            NearToken::from_yoctonear(0)
        } else {
            new_entry_deposit()
        };
        let deposit = env::attached_deposit();
        require!(deposit >= required, "insufficient_deposit");
        let excess = deposit.saturating_sub(required);
        if !excess.is_zero() {
            Promise::new(env::predecessor_account_id())
                .transfer(excess)
                .detach();
        }
        let entry = self.entry(&agent_id, &job_id);
        entry.scams_blocked += 1;
        push_recent(entry, job_id.clone(), Outcome::ScamBlocked, None);
        ReputationEvent::OutcomeRecorded {
            agent_id: &agent_id,
            job_id: &job_id,
            outcome: Outcome::ScamBlocked,
            rating: None,
        }
        .emit();
    }

    pub fn get_reputation(&self, agent_id: AccountId) -> Option<Reputation> {
        self.agents.get(&agent_id).cloned()
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner_id: self.owner_id.clone(),
            jobs_id: self.jobs_id.clone(),
            operator_id: self.operator_id.clone(),
            registry_id: self.registry_id.clone(),
            new_entry_deposit: new_entry_deposit(),
        }
    }
}

impl ReputationRegistry {
    fn entry(&mut self, agent_id: &AccountId, job_id: &str) -> &mut Reputation {
        require!(is_agent_wallet(agent_id, &self.registry_id), "not_agent");
        require!(
            !job_id.is_empty() && job_id.len() <= MAX_JOB_ID_LEN,
            "invalid_job_id"
        );
        self.agents.entry(agent_id.clone()).or_default()
    }
}

fn new_entry_deposit() -> NearToken {
    env::storage_byte_cost().saturating_mul(u128::from(MAX_ENTRY_BYTES))
}

fn push_recent(entry: &mut Reputation, job_id: String, outcome: Outcome, rating: Option<u8>) {
    if entry.recent.len() >= RECENT_OUTCOMES {
        entry.recent.pop_front();
    }
    entry.recent.push_back(OutcomeEntry {
        job_id,
        outcome,
        rating,
        at_ms: env::block_timestamp_ms(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::borsh;

    #[test]
    fn a_full_reputation_entry_fits_in_the_paid_bound() {
        let mut entry = Reputation {
            jobs_completed: u64::MAX,
            rating_sum: u64::MAX,
            rated_jobs: u64::MAX,
            disputes_lost: u64::MAX,
            scams_blocked: u64::MAX,
            recent: VecDeque::new(),
        };
        for _ in 0..RECENT_OUTCOMES {
            entry.recent.push_back(OutcomeEntry {
                job_id: "j".repeat(MAX_JOB_ID_LEN),
                outcome: Outcome::Completed,
                rating: Some(5),
                at_ms: u64::MAX,
            });
        }
        let value = borsh::to_vec(&entry).unwrap().len() as u64;
        // Key: prefix byte plus a 64-byte account id with its length; 40 bytes of record overhead.
        let total = value + 1 + 4 + 64 + 40;
        assert!(total <= MAX_ENTRY_BYTES, "entry {total} bytes");
    }
}
