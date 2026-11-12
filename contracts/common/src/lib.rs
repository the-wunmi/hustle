//! Types, limits and cross-contract interfaces shared by the Hustle contracts.
//!
//! This is a plain library (no `#[near(contract_state)]`), so linking it into a contract adds no
//! exported methods.

use near_sdk::json_types::U128;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas};

/// Largest amount any single money argument may carry: one billion dollars in micro-USD. It keeps
/// every sum the contracts compute (caps, reservations, fees) far below `u128::MAX`.
pub const MAX_AMOUNT: u128 = 1_000_000_000_000_000;

/// Most tool vendors a rulebook may list. Sixteen covers every vendor the game offers while keeping
/// the wallet's state (paid from its own funding) small and bounded.
pub const MAX_ALLOWED_VENDORS: usize = 16;

/// Gas for a NEP-141 `ft_transfer`; the standard implementation uses about 5 Tgas.
pub const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);

/// Gas for NEP-145 `storage_deposit` on the credits token.
pub const GAS_FOR_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);

/// The most bytes a callback reads from a promise result. Our callees return at most a small JSON
/// object, so anything longer is treated as a failure instead of burning gas on reading it.
pub const MAX_PROMISE_RESULT_LEN: usize = 512;

/// The spending rules an owner sets for their agent. Amounts are micro-USD.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rulebook {
    /// Total spend per UTC day.
    pub daily_cap: U128,
    /// Total spend attributed to one job id.
    pub max_per_job: U128,
    /// One spend request.
    pub max_per_call: U128,
    /// Tool receivers; empty means none.
    pub allowed_vendors: Vec<AccountId>,
    /// Loose mode: any receiver is allowed for tools (the scam lesson).
    pub any_vendor: bool,
    pub may_hire: bool,
    /// Most one hire may cost.
    pub helper_budget: U128,
}

impl Rulebook {
    /// The rulebook a new agent gets when the minter supplies none: nothing may be spent until the
    /// owner sets real limits.
    pub fn locked() -> Self {
        Self {
            daily_cap: U128(0),
            max_per_job: U128(0),
            max_per_call: U128(0),
            allowed_vendors: Vec::new(),
            any_vendor: false,
            may_hire: false,
            helper_budget: U128(0),
        }
    }

    /// Panics with a short code if the rulebook would exceed the wallet's storage bounds.
    pub fn assert_valid(&self) {
        require!(
            self.allowed_vendors.len() <= MAX_ALLOWED_VENDORS,
            "too_many_vendors"
        );
        for (i, vendor) in self.allowed_vendors.iter().enumerate() {
            require!(
                !self.allowed_vendors[..i].contains(vendor),
                "duplicate_vendor"
            );
        }
        for cap in [
            self.daily_cap,
            self.max_per_job,
            self.max_per_call,
            self.helper_budget,
        ] {
            require!(cap.0 <= MAX_AMOUNT, "amount_too_large");
        }
    }
}

/// True if `account_id` is a direct sub-account of the registry (`<label>.<registry_id>`). Only the
/// registry can create such accounts, and it only creates agent wallets, so this suffix check is
/// how other contracts recognise an agent without a cross-contract call.
pub fn is_agent_wallet(account_id: &AccountId, registry_id: &AccountId) -> bool {
    let account = account_id.as_str();
    let registry = registry_id.as_str();
    match account.strip_suffix(registry) {
        Some(prefix) => match prefix.strip_suffix('.') {
            Some(label) => !label.is_empty() && !label.contains('.'),
            None => false,
        },
        None => false,
    }
}

/// True if promise result `index` of the current callback succeeded.
pub fn promise_succeeded(index: u64) -> bool {
    env::promise_result_checked(index, MAX_PROMISE_RESULT_LEN).is_ok()
}

/// The two NEP-141 / NEP-145 methods the other contracts call on the credits token.
#[ext_contract(ext_ft)]
pub trait Credits {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    #[test]
    fn only_direct_sub_accounts_of_the_registry_count_as_agents() {
        let registry = id("agents.hustle.near");
        assert!(is_agent_wallet(
            &id("agent-1.agents.hustle.near"),
            &registry
        ));
        assert!(!is_agent_wallet(&id("agents.hustle.near"), &registry));
        assert!(!is_agent_wallet(
            &id("x.agent-1.agents.hustle.near"),
            &registry
        ));
        assert!(!is_agent_wallet(&id("evilagents.hustle.near"), &registry));
        assert!(!is_agent_wallet(&id("alice.near"), &registry));
    }
}
