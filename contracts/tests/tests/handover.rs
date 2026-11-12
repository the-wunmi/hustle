//! An agent changing hands while something else is in flight: a job payout, the seller's attempt to
//! empty a listed wallet, or an owner call sent alongside the transfer. Racing transactions are
//! submitted back to back without waiting (`transact_async`), so they land in the same or
//! neighbouring blocks, and every assertion holds whichever lands first.

use anyhow::Result;
use hustle_integration_tests::*;
use near_workspaces::operations::CallTransaction;
use near_workspaces::result::{ExecutionFinalResult, ExecutionOutcome};
use near_workspaces::types::Gas;
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};

const PRICE: u128 = 5 * DOLLAR;
/// A $2 job pays the agent $1.90 after the 5% platform fee.
const JOB_PRICE: u128 = 2 * DOLLAR;
const PAYOUT: u128 = JOB_PRICE - JOB_PRICE * FEE_BPS as u128 / 10_000;

/// Submits `first` then `second` without waiting for either, then waits for both.
async fn race(
    first: CallTransaction,
    second: CallTransaction,
) -> Result<(ExecutionFinalResult, ExecutionFinalResult)> {
    let first = first.transact_async().await?;
    let second = second.transact_async().await?;
    Ok((first.await?, second.await?))
}

fn transfer_tx(w: &World, from: &Account, wallet: &AccountId, to: &Account) -> CallTransaction {
    from.call(w.registry.id(), "nft_transfer")
        .args_json(json!({ "receiver_id": to.id(), "token_id": wallet }))
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(100))
}

fn buy_tx(w: &World, buyer: &Account, wallet: &AccountId, price: u128) -> CallTransaction {
    buyer
        .call(w.credits.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": w.market.id(),
            "amount": price.to_string(),
            "msg": json!({ "token_id": wallet, "expected_price": price.to_string() }).to_string(),
        }))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
}

fn owner_tx(w: &World, caller: &Account, method: &str, args: Value) -> CallTransaction {
    caller
        .call(w.registry.id(), method)
        .args_json(args)
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(150))
}

fn jobs_tx(w: &World, caller: &Account, method: &str, job_id: u64) -> CallTransaction {
    let args = if method == "accept" {
        json!({ "job_id": job_id, "rating": 5 })
    } else {
        json!({ "job_id": job_id })
    };
    caller
        .call(w.jobs.id(), method)
        .args_json(args)
        .gas(Gas::from_tgas(150))
}

fn withdraw_args(wallet: &AccountId, amount: u128) -> Value {
    json!({ "token_id": wallet, "amount": amount.to_string() })
}

/// A rulebook a seller would set to drain the agent later: any vendor, high caps.
fn loose_rulebook() -> Value {
    let mut rb = rulebook();
    rb["any_vendor"] = json!(true);
    rb["max_per_call"] = json!((5 * DOLLAR).to_string());
    rb
}

/// The lowest block height among the receipts of `r` that match `pick`.
async fn first_height(
    w: &World,
    r: &ExecutionFinalResult,
    pick: impl Fn(&ExecutionOutcome) -> bool,
) -> Result<Option<u64>> {
    let mut lowest = None;
    for outcome in r.receipt_outcomes().iter().filter(|o| pick(o)) {
        let height = w
            .worker
            .view_block()
            .block_hash(outcome.block_hash)
            .await?
            .height();
        lowest = Some(lowest.map_or(height, |l: u64| l.min(height)));
    }
    Ok(lowest)
}

fn logs_event(outcome: &ExecutionOutcome, name: &str) -> bool {
    let needle = format!("\"event\":\"{name}\"");
    outcome.logs.iter().any(|l| l.contains(&needle))
}

/// After a handover mid-payout: the seller is refused every owner action that reaches the money,
/// and the buyer withdraws everything the wallet holds, payout included, while it is still frozen.
async fn assert_only_the_buyer_controls(
    w: &World,
    wallet: &AccountId,
    seller: &Account,
    buyer: &Account,
    expected_in_wallet: u128,
) -> Result<()> {
    assert_eq!(w.balance(wallet).await?, expected_in_wallet);
    for (method, args) in [
        ("withdraw", withdraw_args(wallet, DOLLAR)),
        (
            "approve_spend",
            json!({ "token_id": wallet, "request_id": 0 }),
        ),
        (
            "set_rulebook",
            json!({ "token_id": wallet, "rulebook": loose_rulebook() }),
        ),
    ] {
        let r = w.owner_action(seller, method, args, ONE_YOCTO).await?;
        assert_failed_with(&r, "not_owner");
    }
    assert_eq!(w.wallet(wallet).await?["frozen"], true);
    let before = w.balance(buyer.id()).await?;
    ok(w.owner_action(
        buyer,
        "withdraw",
        withdraw_args(wallet, expected_in_wallet),
        ONE_YOCTO,
    )
    .await?)?;
    assert_eq!(w.balance(buyer.id()).await?, before + expected_in_wallet);
    assert_eq!(w.balance(wallet).await?, 0);
    Ok(())
}

// ── A sale in the middle of a payout ────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_payout_racing_a_market_sale_lands_in_the_wallet_only_the_buyer_controls() -> Result<()> {
    let w = World::new().await?;
    let wallet = w.listed_agent(PRICE).await?;
    w.mint_credits(w.client.id(), 10 * DOLLAR).await?;
    let job_id = w
        .delivered_job("job-race", &wallet, JOB_PRICE, JOB_PRICE, 60_000)
        .await?;

    let (accepted, bought) = race(
        jobs_tx(&w, &w.client, "accept", job_id),
        buy_tx(&w, &w.bob, &wallet, PRICE),
    )
    .await?;
    ok(accepted)?;
    ok(bought.clone())?;
    assert_eq!(kept(&bought), PRICE);
    assert_eq!(w.owner_of(&wallet).await?, w.bob.id().as_str());

    // The seller got the sale price less the market fee, and nothing of the payout.
    assert_eq!(w.balance(w.alice.id()).await?, PRICE - market_fee(PRICE));
    assert_only_the_buyer_controls(&w, &wallet, &w.alice, &w.bob, 5 * DOLLAR + PAYOUT).await
}

#[tokio::test]
async fn a_payout_released_while_the_seller_transfers_the_agent_goes_to_the_new_holder(
) -> Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    w.mint_credits(w.client.id(), 10 * DOLLAR).await?;
    let job_id = w
        .delivered_job("job-expired", &wallet, JOB_PRICE, JOB_PRICE, 1_000)
        .await?;
    w.worker.fast_forward(30).await?;

    // Anyone may release a job whose review window closed; here it races a direct transfer.
    let (transferred, released) = race(
        transfer_tx(&w, &w.alice, &wallet, &w.bob),
        jobs_tx(&w, &w.stranger, "release_expired", job_id),
    )
    .await?;
    ok(transferred)?;
    ok(released)?;
    assert_eq!(w.owner_of(&wallet).await?, w.bob.id().as_str());

    assert_eq!(w.balance(w.alice.id()).await?, 0);
    assert_only_the_buyer_controls(&w, &wallet, &w.alice, &w.bob, PAYOUT).await
}

#[tokio::test]
async fn a_payout_that_lands_just_before_the_sale_moves_with_the_wallet_to_the_buyer() -> Result<()>
{
    let w = World::new().await?;
    let wallet = w.listed_agent(PRICE).await?;
    w.mint_credits(w.client.id(), 10 * DOLLAR).await?;
    let job_id = w
        .delivered_job("job-before", &wallet, JOB_PRICE, JOB_PRICE, 60_000)
        .await?;
    ok(w.jobs_call(
        &w.client,
        "accept",
        json!({ "job_id": job_id, "rating": 5 }),
    )
    .await?)?;
    // The seller sees the payout arrive but, still listed, cannot take it out before the sale.
    let r = w
        .owner_action(
            &w.alice,
            "withdraw",
            withdraw_args(&wallet, PAYOUT),
            ONE_YOCTO,
        )
        .await?;
    assert_failed_with(&r, "listed");
    ok(w.buy(&w.bob, &wallet, PRICE, PRICE).await?)?;

    assert_eq!(w.balance(w.alice.id()).await?, PRICE - market_fee(PRICE));
    assert_only_the_buyer_controls(&w, &wallet, &w.alice, &w.bob, 5 * DOLLAR + PAYOUT).await
}

#[tokio::test]
async fn a_payout_that_lands_just_after_the_sale_goes_to_the_buyer_not_the_seller() -> Result<()> {
    let w = World::new().await?;
    let wallet = w.listed_agent(PRICE).await?;
    w.mint_credits(w.client.id(), 10 * DOLLAR).await?;
    let job_id = w
        .delivered_job("job-after", &wallet, JOB_PRICE, JOB_PRICE, 60_000)
        .await?;
    ok(w.buy(&w.bob, &wallet, PRICE, PRICE).await?)?;
    ok(w.jobs_call(
        &w.client,
        "accept",
        json!({ "job_id": job_id, "rating": 5 }),
    )
    .await?)?;

    assert_eq!(w.balance(w.alice.id()).await?, PRICE - market_fee(PRICE));
    assert_only_the_buyer_controls(&w, &wallet, &w.alice, &w.bob, 5 * DOLLAR + PAYOUT).await
}

// ── Withdraw refused while listed ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_listed_agent_cannot_be_emptied_until_the_seller_unlists_and_a_later_buy_is_refunded(
) -> Result<()> {
    let w = World::new().await?;
    let wallet = w.listed_agent(PRICE).await?;
    let r = w
        .owner_action(
            &w.alice,
            "withdraw",
            withdraw_args(&wallet, 5 * DOLLAR),
            ONE_YOCTO,
        )
        .await?;
    assert_failed_with(&r, "listed");
    assert_eq!(w.balance(&wallet).await?, 5 * DOLLAR);
    // Other owner actions are unchanged while listed.
    w.set_rulebook(&w.alice, &wallet, rulebook()).await?;
    ok(w.owner_action(
        &w.alice,
        "set_frozen",
        json!({ "token_id": wallet, "frozen": false }),
        ONE_YOCTO,
    )
    .await?)?;

    // Unlisting as the game does it: cancel on the market, then revoke the approval.
    ok(w.alice
        .call(w.market.id(), "cancel_listing")
        .args_json(json!({ "token_id": wallet }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?)?;
    // Cancelling on the market alone leaves the approval, so the agent is still listed.
    let r = w
        .owner_action(
            &w.alice,
            "withdraw",
            withdraw_args(&wallet, DOLLAR),
            ONE_YOCTO,
        )
        .await?;
    assert_failed_with(&r, "listed");
    ok(w.alice
        .call(w.registry.id(), "nft_revoke")
        .args_json(json!({ "token_id": wallet, "account_id": w.market.id() }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?)?;
    ok(w.owner_action(
        &w.alice,
        "withdraw",
        withdraw_args(&wallet, 2 * DOLLAR),
        ONE_YOCTO,
    )
    .await?)?;
    assert_eq!(w.balance(w.alice.id()).await?, 2 * DOLLAR);

    // A buyer who saw the old listing pays and is refunded in full; the seller keeps the agent.
    let r = w.buy(&w.bob, &wallet, PRICE, PRICE).await?;
    assert_eq!(kept(&r), 0);
    assert_eq!(refund_reason(&r), "not_listed");
    assert_eq!(w.balance(w.bob.id()).await?, 50 * DOLLAR);
    assert_eq!(w.owner_of(&wallet).await?, w.alice.id().as_str());
    assert_eq!(w.balance(&wallet).await?, 3 * DOLLAR);
    Ok(())
}

#[tokio::test]
async fn revoking_the_approval_alone_unlists_and_any_approval_counts_as_listed() -> Result<()> {
    let w = World::new().await?;
    let wallet = w.listed_agent(PRICE).await?;
    // nft_revoke without cancelling: the market still has the listing but no approval behind it.
    ok(w.alice
        .call(w.registry.id(), "nft_revoke")
        .args_json(json!({ "token_id": wallet, "account_id": w.market.id() }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?)?;
    ok(w.owner_action(
        &w.alice,
        "withdraw",
        withdraw_args(&wallet, DOLLAR),
        ONE_YOCTO,
    )
    .await?)?;
    let r = w.buy(&w.bob, &wallet, PRICE, PRICE).await?;
    assert_eq!(kept(&r), 0);
    assert_eq!(refund_reason(&r), "transfer_failed");
    assert_eq!(w.balance(w.bob.id()).await?, 50 * DOLLAR);
    assert_eq!(w.owner_of(&wallet).await?, w.alice.id().as_str());

    // An approval for any account could move the token, so it blocks withdraw as a listing does.
    ok(w.alice
        .call(w.registry.id(), "nft_approve")
        .args_json(json!({ "token_id": wallet, "account_id": w.stranger.id() }))
        .deposit(near_workspaces::types::NearToken::from_millinear(10))
        .transact()
        .await?)?;
    let r = w
        .owner_action(
            &w.alice,
            "withdraw",
            withdraw_args(&wallet, DOLLAR),
            ONE_YOCTO,
        )
        .await?;
    assert_failed_with(&r, "listed");
    ok(w.list(&w.alice, &wallet, PRICE).await?)?;
    let r = w
        .owner_action(
            &w.alice,
            "withdraw",
            withdraw_args(&wallet, DOLLAR),
            ONE_YOCTO,
        )
        .await?;
    assert_failed_with(&r, "listed");
    // nft_revoke_all clears both; withdraw works again.
    ok(w.alice
        .call(w.registry.id(), "nft_revoke_all")
        .args_json(json!({ "token_id": wallet }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?)?;
    ok(w.owner_action(
        &w.alice,
        "withdraw",
        withdraw_args(&wallet, DOLLAR),
        ONE_YOCTO,
    )
    .await?)?;
    assert_eq!(w.balance(w.alice.id()).await?, 2 * DOLLAR);
    assert_eq!(w.balance(&wallet).await?, 3 * DOLLAR);
    Ok(())
}

#[tokio::test]
async fn a_buy_racing_the_unlisting_either_completes_or_is_refunded_in_full() -> Result<()> {
    let w = World::new().await?;
    for revoke_first in [false, true] {
        let wallet = w.listed_agent(PRICE).await?;
        let alice_before = w.balance(w.alice.id()).await?;
        let bob_before = w.balance(w.bob.id()).await?;
        let revoke = w
            .alice
            .call(w.registry.id(), "nft_revoke")
            .args_json(json!({ "token_id": wallet, "account_id": w.market.id() }))
            .deposit(ONE_YOCTO);
        let buy = buy_tx(&w, &w.bob, &wallet, PRICE);
        let (bought, revoked) = if revoke_first {
            let (revoked, bought) = race(revoke, buy).await?;
            (bought, revoked)
        } else {
            race(buy, revoke).await?
        };
        // A buy the market accepted before the revoke landed fails at its `nft_transfer` receipt
        // and is refunded by the market's callback, so the transaction itself still succeeds.
        assert!(bought.is_success());
        let sold = kept(&bought) == PRICE;
        eprintln!("revoke first: {revoke_first}; sold: {sold}");
        if sold {
            ok(bought.clone())?;
            // The sale moved the token first; the seller's revoke came too late to matter.
            assert_failed_with(&revoked, "Predecessor must be token owner");
            assert_eq!(w.owner_of(&wallet).await?, w.bob.id().as_str());
            assert_eq!(w.balance(w.bob.id()).await?, bob_before - PRICE);
            assert_eq!(
                w.balance(w.alice.id()).await?,
                alice_before + PRICE - market_fee(PRICE)
            );
            assert_eq!(w.balance(&wallet).await?, 5 * DOLLAR);
        } else {
            // Unlisted first: the buy is refunded in full and the seller may now withdraw.
            ok(revoked)?;
            assert_eq!(kept(&bought), 0);
            assert_eq!(refund_reason(&bought), "transfer_failed");
            assert_eq!(w.owner_of(&wallet).await?, w.alice.id().as_str());
            assert_eq!(w.balance(w.bob.id()).await?, bob_before);
            assert_eq!(w.balance(w.alice.id()).await?, alice_before);
            ok(w.owner_action(
                &w.alice,
                "withdraw",
                withdraw_args(&wallet, DOLLAR),
                ONE_YOCTO,
            )
            .await?)?;
        }
        assert_eq!(w.balance(w.market.id()).await?, 0);
    }
    Ok(())
}

// ── An owner call racing the transfer ───────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
enum OwnerCall {
    SetRulebook,
    Withdraw,
}

#[derive(Clone, Copy, Debug)]
enum Handover {
    DirectTransfer,
    MarketSale,
}

/// The old owner's call either applied before the rotation (its wallet receipt is no later than
/// the rotation's) or was refused: by the registry (`not_owner`) or by the wallet (`stale_owner`).
/// Nothing the old owner sent applies after the wallet rotated.
#[tokio::test]
async fn an_owner_call_racing_the_transfer_never_takes_effect_after_the_rotation() -> Result<()> {
    let w = World::new().await?;
    w.mint_credits(w.bob.id(), 50 * DOLLAR).await?;
    let cases = [
        (OwnerCall::SetRulebook, Handover::MarketSale, true),
        (OwnerCall::SetRulebook, Handover::MarketSale, false),
        (OwnerCall::SetRulebook, Handover::DirectTransfer, true),
        (OwnerCall::Withdraw, Handover::DirectTransfer, true),
        (OwnerCall::Withdraw, Handover::DirectTransfer, false),
    ];
    for (call, handover, owner_call_first) in cases {
        let case = format!("{call:?} vs {handover:?}, owner call first: {owner_call_first}");
        let wallet = w.mint_agent(&w.alice).await?;
        w.mint_credits(&wallet, 5 * DOLLAR).await?;
        if let Handover::MarketSale = handover {
            ok(w.list(&w.alice, &wallet, PRICE).await?)?;
        }
        let alice_before = w.balance(w.alice.id()).await?;
        let owner_call = match call {
            OwnerCall::SetRulebook => owner_tx(
                &w,
                &w.alice,
                "set_rulebook",
                json!({ "token_id": wallet, "rulebook": loose_rulebook() }),
            ),
            OwnerCall::Withdraw => {
                owner_tx(&w, &w.alice, "withdraw", withdraw_args(&wallet, DOLLAR))
            }
        };
        let handover_tx = match handover {
            Handover::DirectTransfer => transfer_tx(&w, &w.alice, &wallet, &w.bob),
            Handover::MarketSale => buy_tx(&w, &w.bob, &wallet, PRICE),
        };
        let (owner_r, handover_r) = if owner_call_first {
            race(owner_call, handover_tx).await?
        } else {
            let (handover_r, owner_r) = race(handover_tx, owner_call).await?;
            (owner_r, handover_r)
        };
        ok(handover_r.clone())?;
        if let Handover::MarketSale = handover {
            assert_eq!(kept(&handover_r), PRICE, "{case}");
        }
        let view = w.wallet(&wallet).await?;
        assert_eq!(view["owner_id"], w.bob.id().as_str(), "{case}");
        assert_eq!(view["rotation_seq"], 1, "{case}");
        assert_eq!(view["frozen"], true, "{case}");
        let rotated_at = first_height(&w, &handover_r, |o| logs_event(o, "owner_rotated"))
            .await?
            .expect("the handover rotated the wallet");
        let sale_proceeds = match handover {
            Handover::MarketSale => PRICE - market_fee(PRICE),
            Handover::DirectTransfer => 0,
        };

        let applied = owner_r.is_success() && owner_r.receipt_failures().is_empty();
        eprintln!(
            "{case}: {}",
            if applied {
                "applied before the rotation"
            } else {
                "refused"
            }
        );
        if applied {
            // Applied under the old sequence, so in the wallet before the rotation.
            let applied_at = first_height(&w, &owner_r, |o| o.executor_id == wallet)
                .await?
                .expect("the owner call reached the wallet");
            assert!(applied_at <= rotated_at, "{case}: applied after rotation");
        } else {
            assert!(
                failed_with(&owner_r, "not_owner") || failed_with(&owner_r, "stale_owner"),
                "{case}: refused for another reason: {:?}",
                owner_r.receipt_failures()
            );
        }
        match call {
            OwnerCall::SetRulebook => {
                let expected = if applied {
                    loose_rulebook()
                } else {
                    rulebook()
                };
                assert_eq!(view["rulebook"], expected, "{case}");
                assert_eq!(
                    w.balance(w.alice.id()).await?,
                    alice_before + sale_proceeds,
                    "{case}"
                );
            }
            OwnerCall::Withdraw => {
                let taken = if applied { DOLLAR } else { 0 };
                assert!(!applied || owner_r.clone().json::<bool>()?, "{case}");
                assert_eq!(
                    w.balance(w.alice.id()).await?,
                    alice_before + taken,
                    "{case}"
                );
                assert_eq!(w.balance(&wallet).await?, 5 * DOLLAR - taken, "{case}");
            }
        }
        // Whatever the race did, the same call now is refused.
        let again = w
            .owner_action(
                &w.alice,
                "withdraw",
                withdraw_args(&wallet, DOLLAR),
                ONE_YOCTO,
            )
            .await?;
        assert_failed_with(&again, "not_owner");
    }
    Ok(())
}
