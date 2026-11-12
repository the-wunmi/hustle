//! Test fixture: a hostile NFT receiver. In `nft_on_transfer` it calls the registry's `withdraw` and
//! `set_rulebook` for the token it is being sent (it is the provisional holder at that moment), then
//! returns `true` so the token goes back to the sender.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise, PromiseOrValue};

const GAS_PER_CALL: Gas = Gas::from_tgas(80);

#[near(contract_state)]
#[derive(Default)]
pub struct Receiver {}

#[near]
impl Receiver {
    /// NEP-171 receiver. `msg` is the amount to try to withdraw.
    pub fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: String,
        msg: String,
    ) -> PromiseOrValue<bool> {
        let _ = (sender_id, previous_owner_id);
        let registry = env::predecessor_account_id();
        let amount: u128 = msg.parse().unwrap_or(1);
        let loose = json!({
            "daily_cap": "1000000000000", "max_per_job": "1000000000000",
            "max_per_call": "1000000000000", "allowed_vendors": [], "any_vendor": true,
            "may_hire": true, "helper_budget": "1000000000000",
        });
        Promise::new(registry.clone())
            .function_call(
                "withdraw".to_string(),
                json!({ "token_id": token_id, "amount": U128(amount) })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_PER_CALL,
            )
            .and(
                Promise::new(registry).function_call(
                    "set_rulebook".to_string(),
                    json!({ "token_id": token_id, "rulebook": loose })
                        .to_string()
                        .into_bytes(),
                    NearToken::from_yoctonear(1),
                    GAS_PER_CALL,
                ),
            )
            .then(Self::ext(env::current_account_id()).hand_back())
            .into()
    }

    /// Returns `true` whatever the attack did, so the registry returns the token.
    #[private]
    pub fn hand_back(&mut self) -> bool {
        true
    }
}
