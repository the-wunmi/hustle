//! Agent market. An owner lists an agent NFT by approving this contract on the registry (NEP-178)
//! with a price; a buyer pays in credits with `ft_transfer_call`; the market moves the NFT with the
//! approval and pays the seller and the treasury only once the transfer has succeeded. Any refused
//! or failed buy returns the buyer's credits in full. The agent's wallet, money and history move
//! with the NFT; the registry rotates the wallet's owner and freezes it until the buyer unfreezes it.
//!
//! Storage: listings (at most `MAX_LISTINGS`) and owed payouts (at most `MAX_OWED`) are paid from
//! this contract's own balance. Only the registry can create a listing, and only for a token whose
//! holder approved this contract, so each listing is backed by a real agent.

use hustle_common::{ext_ft, promise_succeeded, GAS_FOR_FT_TRANSFER, MAX_AMOUNT};
use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, PromiseOrValue,
};

/// Most listings at once. Each costs this contract about 300 bytes (3 milliNEAR), so 500 cap the
/// storage a crowd of sellers can make it pay at 1.5 NEAR.
pub const MAX_LISTINGS: u32 = 500;

/// Highest price: 1,000 credits (micro-USD). Agents are game items; a larger number is a typo.
pub const MAX_PRICE: u128 = 1_000_000_000;

/// Highest market fee: 20%, as the job board. Guards against a fat-fingered `fee_bps` at deploy.
pub const MAX_FEE_BPS: u16 = 2_000;

/// Receivers with a payout waiting for a retry. A payout only fails when its receiver unregistered
/// from the credits token; past this bound the amount is owed to the treasury instead, so storage
/// stays bounded and nothing is lost.
pub const MAX_OWED: u32 = 500;

/// Largest page of `get_listings`.
pub const MAX_PAGE: u64 = 100;

/// The registry's `nft_transfer` and the `rotate_owner` it sends (15 Tgas).
const GAS_FOR_NFT_TRANSFER: Gas = Gas::from_tgas(40);
/// `on_sale`: two payouts, each a transfer and its callback, plus its own work.
const GAS_FOR_ON_SALE: Gas = Gas::from_tgas(70);
const GAS_FOR_PAYOUT_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_FOR_IS_APPROVED: Gas = Gas::from_tgas(10);
const GAS_FOR_ON_PRUNED: Gas = Gas::from_tgas(10);
/// A buy needs this much left in `ft_on_transfer`. Below it the buy is refunded up front: once the
/// NFT has moved, `on_sale` must run, or the token contract would refund a buyer who got the agent.
const GAS_FOR_BUY: Gas =
    Gas::from_tgas(GAS_FOR_NFT_TRANSFER.as_tgas() + GAS_FOR_ON_SALE.as_tgas() + 10);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Listings,
    Owed,
}

#[ext_contract(ext_registry)]
pub trait Registry {
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    );
    fn nft_is_approved(
        &self,
        token_id: String,
        approved_account_id: AccountId,
        approval_id: Option<u64>,
    ) -> bool;
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listing {
    pub token_id: String,
    pub seller_id: AccountId,
    pub price: U128,
    /// The registry's approval id for this market; a buy transfers with exactly this id, so a
    /// listing is void once the token moves or the seller approves again.
    pub approval_id: u64,
    /// A buy's `nft_transfer` is in flight; other buys are refunded until it resolves.
    pub sale_in_flight: bool,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner_id: AccountId,
    pub registry_id: AccountId,
    pub credits_id: AccountId,
    pub treasury_id: AccountId,
    pub fee_bps: u16,
    pub listing_count: u32,
    pub max_listings: u32,
    pub max_price: U128,
}

/// `nft_on_approve`'s message.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct ListMsg {
    price: U128,
}

/// `ft_on_transfer`'s message.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct BuyMsg {
    token_id: String,
    expected_price: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RefundReason {
    InvalidMsg,
    NotListed,
    SelfPurchase,
    SaleInFlight,
    PriceChanged,
    WrongAmount,
    NotEnoughGas,
    /// The registry refused the transfer: the token moved, the seller no longer holds it, the
    /// approval was replaced, or an `nft_transfer_call` is in flight.
    TransferFailed,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UnlistReason {
    Cancelled,
    /// The registry no longer approves this market for the listing (`prune_listing`).
    Stale,
}

/// NEP-297 events, standard `hustle`.
#[near(event_json(standard = "hustle"))]
pub enum MarketEvent<'a> {
    #[event_version("1.0.0")]
    Listed {
        token_id: &'a str,
        seller_id: &'a AccountId,
        price: U128,
        approval_id: u64,
    },
    #[event_version("1.0.0")]
    Unlisted {
        token_id: &'a str,
        seller_id: &'a AccountId,
        reason: UnlistReason,
    },
    #[event_version("1.0.0")]
    Sold {
        token_id: &'a str,
        seller_id: &'a AccountId,
        buyer_id: &'a AccountId,
        price: U128,
        fee: U128,
    },
    #[event_version("1.0.0")]
    BuyRefunded {
        token_id: Option<&'a str>,
        buyer_id: &'a AccountId,
        amount: U128,
        reason: RefundReason,
    },
    #[event_version("1.0.0")]
    PayoutFailed {
        receiver_id: &'a AccountId,
        amount: U128,
        /// Who the amount is now owed to: the receiver, or the treasury once `MAX_OWED` is reached.
        owed_to: &'a AccountId,
    },
    #[event_version("1.0.0")]
    PayoutSent {
        receiver_id: &'a AccountId,
        amount: U128,
    },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    owner_id: AccountId,
    registry_id: AccountId,
    credits_id: AccountId,
    treasury_id: AccountId,
    fee_bps: u16,
    listings: IterableMap<String, Listing>,
    owed: LookupMap<AccountId, u128>,
    owed_count: u32,
}

#[near]
impl Market {
    #[init]
    pub fn new(
        owner_id: AccountId,
        registry_id: AccountId,
        credits_id: AccountId,
        treasury_id: AccountId,
        fee_bps: u16,
    ) -> Self {
        require!(fee_bps <= MAX_FEE_BPS, "fee_too_high");
        Self {
            owner_id,
            registry_id,
            credits_id,
            treasury_id,
            fee_bps,
            listings: IterableMap::new(StorageKey::Listings),
            owed: LookupMap::new(StorageKey::Owed),
            owed_count: 0,
        }
    }

    /// NEP-178 approval receiver, registry only (the registry checked that `owner_id` holds the
    /// token and approved this market). `msg` is `{"price":"<U128>"}`. Creates or replaces the
    /// token's listing and returns it.
    pub fn nft_on_approve(
        &mut self,
        token_id: String,
        owner_id: AccountId,
        approval_id: u64,
        msg: String,
    ) -> Listing {
        require!(
            env::predecessor_account_id() == self.registry_id,
            "not_registry"
        );
        let ListMsg { price } =
            serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("invalid_msg"));
        require!(price.0 > 0 && price.0 <= MAX_PRICE, "invalid_price");
        require!(
            self.listings.contains_key(&token_id) || self.listings.len() < MAX_LISTINGS,
            "too_many_listings"
        );
        let listing = Listing {
            token_id: token_id.clone(),
            seller_id: owner_id,
            price,
            approval_id,
            sale_in_flight: false,
        };
        MarketEvent::Listed {
            token_id: &listing.token_id,
            seller_id: &listing.seller_id,
            price,
            approval_id,
        }
        .emit();
        self.listings.insert(token_id, listing.clone());
        listing
    }

    /// The listing's seller, exactly 1 yoctoNEAR. Removes the listing; the seller should also
    /// `nft_revoke` the market on the registry, which refunds the approval's storage.
    #[payable]
    pub fn cancel_listing(&mut self, token_id: String) {
        assert_one_yocto();
        let listing = self
            .listings
            .get(&token_id)
            .unwrap_or_else(|| env::panic_str("not_found"));
        require!(
            env::predecessor_account_id() == listing.seller_id,
            "not_seller"
        );
        let seller_id = listing.seller_id.clone();
        self.listings.remove(&token_id);
        MarketEvent::Unlisted {
            token_id: &token_id,
            seller_id: &seller_id,
            reason: UnlistReason::Cancelled,
        }
        .emit();
    }

    /// Anyone, no deposit. Asks the registry whether the listing's approval still holds and removes
    /// the listing if not (the token moved some other way), so stale listings don't fill the cap.
    pub fn prune_listing(&mut self, token_id: String) -> near_sdk::Promise {
        let listing = self
            .listings
            .get(&token_id)
            .unwrap_or_else(|| env::panic_str("not_found"));
        ext_registry::ext(self.registry_id.clone())
            .with_static_gas(GAS_FOR_IS_APPROVED)
            .nft_is_approved(
                token_id.clone(),
                env::current_account_id(),
                Some(listing.approval_id),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_PRUNED)
                    .on_pruned(token_id, listing.approval_id),
            )
    }

    /// Returns true if the listing was removed. A failed view (the token is gone) counts as stale.
    #[private]
    pub fn on_pruned(&mut self, token_id: String, approval_id: u64) -> bool {
        let approved = env::promise_result_checked(0, 16)
            .ok()
            .and_then(|v| serde_json::from_slice::<bool>(&v).ok())
            .unwrap_or(false);
        let Some(listing) = self.listings.get(&token_id) else {
            return false;
        };
        if approved || listing.approval_id != approval_id || listing.sale_in_flight {
            return false;
        }
        let seller_id = listing.seller_id.clone();
        self.listings.remove(&token_id);
        MarketEvent::Unlisted {
            token_id: &token_id,
            seller_id: &seller_id,
            reason: UnlistReason::Stale,
        }
        .emit();
        true
    }

    /// NEP-141 receiver, credits token only. `msg` is `{"token_id","expected_price"}`. Returns the
    /// amount to refund: all of it unless the NFT moved to the buyer.
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
        let Ok(BuyMsg {
            token_id,
            expected_price,
        }) = serde_json::from_str::<BuyMsg>(&msg)
        else {
            return refund(None, &sender_id, amount, RefundReason::InvalidMsg);
        };
        let Some(listing) = self.listings.get_mut(&token_id) else {
            return refund(Some(&token_id), &sender_id, amount, RefundReason::NotListed);
        };
        // The seller buying their own agent would only pay the fee to move it nowhere; the
        // registry would refuse the transfer anyway.
        let reason = if listing.seller_id == sender_id {
            Some(RefundReason::SelfPurchase)
        } else if listing.sale_in_flight {
            Some(RefundReason::SaleInFlight)
        } else if expected_price != listing.price {
            // The seller re-listed at another price after the buyer looked: never charge it.
            Some(RefundReason::PriceChanged)
        } else if amount != listing.price {
            Some(RefundReason::WrongAmount)
        } else if env::prepaid_gas().saturating_sub(env::used_gas()) < GAS_FOR_BUY {
            Some(RefundReason::NotEnoughGas)
        } else {
            None
        };
        if let Some(reason) = reason {
            return refund(Some(&token_id), &sender_id, amount, reason);
        }
        listing.sale_in_flight = true;
        let seller_id = listing.seller_id.clone();
        let approval_id = listing.approval_id;
        let price = listing.price;
        ext_registry::ext(self.registry_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_NFT_TRANSFER)
            .nft_transfer(
                sender_id.clone(),
                token_id.clone(),
                Some(approval_id),
                Some("market sale".to_string()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_SALE)
                    .on_sale(token_id, seller_id, sender_id, price, approval_id),
            )
            .into()
    }

    /// Resolves a buy. The NFT moved: the listing goes, the seller gets `price - fee` and the
    /// treasury `fee` (rounded down), and nothing is refunded. It didn't: the buyer is refunded in
    /// full and the listing can be bought again.
    #[private]
    pub fn on_sale(
        &mut self,
        token_id: String,
        seller_id: AccountId,
        buyer_id: AccountId,
        price: U128,
        approval_id: u64,
    ) -> U128 {
        if !promise_succeeded(0) {
            if let Some(listing) = self.listings.get_mut(&token_id) {
                if listing.approval_id == approval_id {
                    listing.sale_in_flight = false;
                }
            }
            MarketEvent::BuyRefunded {
                token_id: Some(&token_id),
                buyer_id: &buyer_id,
                amount: price,
                reason: RefundReason::TransferFailed,
            }
            .emit();
            return price;
        }
        // Whatever is listed for the token now is void: its approvals were cleared by the transfer.
        self.listings.remove(&token_id);
        let fee = fee_of(price.0, self.fee_bps);
        MarketEvent::Sold {
            token_id: &token_id,
            seller_id: &seller_id,
            buyer_id: &buyer_id,
            price,
            fee: U128(fee),
        }
        .emit();
        self.pay(seller_id, price.0 - fee);
        self.pay(self.treasury_id.clone(), fee);
        U128(0)
    }

    /// Anyone, no deposit. Resends what is owed to `account_id` after a failed payout.
    pub fn retry_payout(&mut self, account_id: AccountId) {
        let amount = self
            .owed
            .remove(&account_id)
            .unwrap_or_else(|| env::panic_str("nothing_owed"));
        self.owed_count -= 1;
        self.pay(account_id, amount);
    }

    /// Resolves one payout; a failed one is kept as owed.
    #[private]
    pub fn on_payout(&mut self, receiver_id: AccountId, amount: U128) {
        if promise_succeeded(0) {
            MarketEvent::PayoutSent {
                receiver_id: &receiver_id,
                amount,
            }
            .emit();
            return;
        }
        let owed_to = if self.owed.contains_key(&receiver_id)
            || self.owed_count < MAX_OWED
            || receiver_id == self.treasury_id
        {
            receiver_id.clone()
        } else {
            self.treasury_id.clone()
        };
        MarketEvent::PayoutFailed {
            receiver_id: &receiver_id,
            amount,
            owed_to: &owed_to,
        }
        .emit();
        let previous = self.owed.get(&owed_to).copied();
        if previous.is_none() {
            self.owed_count += 1;
        }
        self.owed
            .insert(owed_to, previous.unwrap_or(0).saturating_add(amount.0));
    }

    pub fn get_listing(&self, token_id: String) -> Option<Listing> {
        self.listings.get(&token_id).cloned()
    }

    pub fn get_listings(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Listing> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize;
        self.listings
            .values()
            .skip(from)
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn get_owed(&self, account_id: AccountId) -> U128 {
        U128(self.owed.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner_id: self.owner_id.clone(),
            registry_id: self.registry_id.clone(),
            credits_id: self.credits_id.clone(),
            treasury_id: self.treasury_id.clone(),
            fee_bps: self.fee_bps,
            listing_count: self.listings.len(),
            max_listings: MAX_LISTINGS,
            max_price: U128(MAX_PRICE),
        }
    }
}

impl Market {
    fn pay(&self, receiver_id: AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        ext_ft::ext(self.credits_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(
                receiver_id.clone(),
                U128(amount),
                Some("market sale".to_string()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_PAYOUT_CALLBACK)
                    .on_payout(receiver_id, U128(amount)),
            )
            .detach();
    }
}

/// The market's cut, rounded down: the seller keeps the remainder. `price <= MAX_AMOUNT` keeps the
/// product far from overflow.
pub fn fee_of(price: u128, fee_bps: u16) -> u128 {
    debug_assert!(price <= MAX_AMOUNT);
    price * u128::from(fee_bps) / 10_000
}

fn refund(
    token_id: Option<&str>,
    buyer_id: &AccountId,
    amount: U128,
    reason: RefundReason,
) -> PromiseOrValue<U128> {
    MarketEvent::BuyRefunded {
        token_id,
        buyer_id,
        amount,
        reason,
    }
    .emit();
    PromiseOrValue::Value(amount)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fee_rounds_down_so_the_seller_keeps_the_remainder() {
        assert_eq!(fee_of(1_000_000, 250), 25_000);
        assert_eq!(fee_of(39, 250), 0);
        assert_eq!(fee_of(MAX_PRICE, MAX_FEE_BPS), MAX_PRICE / 5);
    }
}
