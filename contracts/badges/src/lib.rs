//! Agent badges: a NEP-245 multi-token contract for achievements and skill certificates. Badges are
//! held by the agent wallet account itself, so they move with the agent NFT (the wallet changes
//! owner, the account does not change).
//!
//! Badges are soulbound: `mt_transfer` and friends exist for NEP-245 conformance but always refuse
//! with `soulbound`. A badge records what this agent earned; letting it be traded would let anyone
//! buy a record they did not earn. Selling the agent (its NFT) carries the badges with it.
//!
//! Storage is paid from this contract's balance and bounded: at most `MAX_BADGE_TYPES` badge types
//! (owner-defined, size-capped metadata), each agent holds at most one of each, and only the minter
//! (the game) can mint, only to agent-wallet ids. So each agent's holding is at most
//! `MAX_BADGE_TYPES` ids, and growth is one entry per agent per earned badge.

use hustle_common::is_agent_wallet;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault, PromiseOrValue};

/// Most badge types. 64 covers every achievement and skill the game defines with room to spare, and
/// bounds each agent's holding list.
pub const MAX_BADGE_TYPES: u32 = 64;

/// Longest badge token id (a short slug such as `skill-research-1`).
pub const MAX_TOKEN_ID_LEN: usize = 64;

/// Longest badge title shown in the UI.
pub const MAX_TITLE_LEN: usize = 64;

/// Longest badge description: one or two sentences.
pub const MAX_DESCRIPTION_LEN: usize = 256;

/// Longest mint memo (why the badge was earned, e.g. a job id).
pub const MAX_MEMO_LEN: usize = 128;

/// Most tokens one enumeration view returns.
pub const MAX_PAGE: u64 = 100;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Badges,
    Holdings,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct BadgeMetadata {
    pub title: String,
    pub description: String,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
struct Badge {
    metadata: BadgeMetadata,
    supply: u128,
}

/// NEP-245 `Token`, plus this contract's badge metadata. `owner_id` is always null: a badge type is
/// held by many agents.
#[near(serializers = [json])]
pub struct Token {
    pub token_id: String,
    pub owner_id: Option<AccountId>,
    pub metadata: BadgeMetadata,
}

#[near(event_json(standard = "hustle"))]
pub enum BadgeEvent<'a> {
    #[event_version("1.0.0")]
    BadgeRegistered {
        token_id: &'a str,
        metadata: &'a BadgeMetadata,
    },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Badges {
    owner_id: AccountId,
    minter_id: AccountId,
    registry_id: AccountId,
    badges: IterableMap<String, Badge>,
    /// Badge ids each agent holds (at most `MAX_BADGE_TYPES`, each once).
    holdings: LookupMap<AccountId, Vec<String>>,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner_id: AccountId,
    pub minter_id: AccountId,
    pub registry_id: AccountId,
    pub badge_types: u32,
}

#[near]
impl Badges {
    #[init]
    pub fn new(owner_id: AccountId, minter_id: AccountId, registry_id: AccountId) -> Self {
        Self {
            owner_id,
            minter_id,
            registry_id,
            badges: IterableMap::new(StorageKey::Badges),
            holdings: LookupMap::new(StorageKey::Holdings),
        }
    }

    /// Owner only, no deposit. Defines a badge type, or updates the title and description of an
    /// existing one (supply is kept).
    pub fn register_badge(&mut self, token_id: String, title: String, description: String) {
        require!(env::predecessor_account_id() == self.owner_id, "not_owner");
        require!(
            !token_id.is_empty()
                && token_id.len() <= MAX_TOKEN_ID_LEN
                && token_id.bytes().all(|b| b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || b == b'-'
                    || b == b'_'),
            "invalid_token_id"
        );
        require!(
            !title.is_empty() && title.len() <= MAX_TITLE_LEN,
            "invalid_title"
        );
        require!(
            description.len() <= MAX_DESCRIPTION_LEN,
            "invalid_description"
        );
        let metadata = BadgeMetadata { title, description };
        let supply = match self.badges.get(&token_id) {
            Some(existing) => existing.supply,
            None => {
                require!(self.badges.len() < MAX_BADGE_TYPES, "too_many_badges");
                0
            }
        };
        BadgeEvent::BadgeRegistered {
            token_id: &token_id,
            metadata: &metadata,
        }
        .emit();
        self.badges.insert(token_id, Badge { metadata, supply });
    }

    /// Minter only, no deposit. Gives one badge to an agent wallet. Returns false (and changes
    /// nothing) if the agent already holds it, so retries are safe.
    pub fn mint_badge(
        &mut self,
        agent_id: AccountId,
        token_id: String,
        memo: Option<String>,
    ) -> bool {
        require!(
            env::predecessor_account_id() == self.minter_id,
            "not_minter"
        );
        require!(is_agent_wallet(&agent_id, &self.registry_id), "not_agent");
        if let Some(memo) = &memo {
            require!(memo.len() <= MAX_MEMO_LEN, "memo_too_long");
        }
        let badge = self
            .badges
            .get_mut(&token_id)
            .unwrap_or_else(|| env::panic_str("unknown_badge"));
        let held = self.holdings.entry(agent_id.clone()).or_default();
        if held.contains(&token_id) {
            return false;
        }
        held.push(token_id.clone());
        badge.supply += 1;
        emit_mt_mint(&agent_id, &token_id, memo.as_deref());
        true
    }

    // NEP-245 transfers: badges are soulbound.

    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        let _ = (receiver_id, token_id, amount, approval, memo);
        env::panic_str("soulbound")
    }

    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
    ) {
        let _ = (receiver_id, token_ids, amounts, approvals, memo);
        env::panic_str("soulbound")
    }

    #[payable]
    pub fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        let _ = (receiver_id, token_id, amount, approval, memo, msg);
        env::panic_str("soulbound")
    }

    #[payable]
    pub fn mt_batch_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        let _ = (receiver_id, token_ids, amounts, approvals, memo, msg);
        env::panic_str("soulbound")
    }

    // NEP-245 views.

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(u128::from(self.holds(&account_id, &token_id)))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids
            .iter()
            .map(|id| U128(u128::from(self.holds(&account_id, id))))
            .collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        self.badges.get(&token_id).map(|b| U128(b.supply))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids
            .iter()
            .map(|id| self.badges.get(id).map(|b| U128(b.supply)))
            .collect()
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<Token>> {
        token_ids.into_iter().map(|id| self.token(id)).collect()
    }

    pub fn mt_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let (from, limit) = page(from_index, limit);
        self.badges
            .keys()
            .skip(from)
            .take(limit)
            .filter_map(|id| self.token(id.clone()))
            .collect()
    }

    pub fn mt_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        let (from, limit) = page(from_index, limit);
        self.holdings
            .get(&account_id)
            .map(|held| {
                held.iter()
                    .skip(from)
                    .take(limit)
                    .filter_map(|id| self.token(id.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner_id: self.owner_id.clone(),
            minter_id: self.minter_id.clone(),
            registry_id: self.registry_id.clone(),
            badge_types: self.badges.len(),
        }
    }
}

impl Badges {
    fn holds(&self, account_id: &AccountId, token_id: &String) -> bool {
        self.holdings
            .get(account_id)
            .is_some_and(|held| held.contains(token_id))
    }

    fn token(&self, token_id: String) -> Option<Token> {
        let badge = self.badges.get(&token_id)?;
        Some(Token {
            metadata: badge.metadata.clone(),
            token_id,
            owner_id: None,
        })
    }
}

fn page(from_index: Option<U128>, limit: Option<u64>) -> (usize, usize) {
    let from = usize::try_from(from_index.map_or(0, |i| i.0)).unwrap_or(usize::MAX);
    let limit = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize;
    (from, limit)
}

/// NEP-245 `mt_mint`, written by hand because near-contract-standards has no NEP-245 module.
fn emit_mt_mint(owner_id: &AccountId, token_id: &str, memo: Option<&str>) {
    let mut data = json!({
        "owner_id": owner_id,
        "token_ids": [token_id],
        "amounts": ["1"],
    });
    if let Some(memo) = memo {
        data["memo"] = json!(memo);
    }
    let event = json!({
        "standard": "nep245",
        "version": "1.0.0",
        "event": "mt_mint",
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{event}"));
}
