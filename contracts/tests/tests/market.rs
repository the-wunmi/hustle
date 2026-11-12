//! The agent market: listing by NEP-178 approval, buying with credits, and the attacks on both.

use hustle_integration_tests::*;
use serde_json::json;

#[tokio::test]
async fn a_sale_pays_the_seller_and_treasury_and_hands_over_a_frozen_wallet() -> anyhow::Result<()>
{
    let w = World::new().await?;
    let price = 10 * DOLLAR;
    let wallet = w.listed_agent(price).await?;
    let listing = w.listing(&wallet).await?;
    assert_eq!(listing["seller_id"], w.alice.id().as_str());
    assert_eq!(listing["price"], price.to_string());
    assert_eq!(
        w.view(
            w.registry.id(),
            "nft_is_approved",
            json!({ "token_id": wallet, "approved_account_id": w.market.id(), "approval_id": listing["approval_id"] }),
        )
        .await?,
        true
    );

    let r = w.buy(&w.bob, &wallet, price, price).await?;
    ok(r.clone())?;
    assert_eq!(kept(&r), price);
    let all = events(&r);
    let sold = event(&all, "sold").expect("sold");
    assert_eq!(sold["buyer_id"], w.bob.id().as_str());
    assert_eq!(sold["fee"], market_fee(price).to_string());
    assert_eq!(
        event(&all, "owner_rotated").expect("rotated")["frozen"],
        true
    );

    assert_eq!(w.balance(w.alice.id()).await?, price - market_fee(price));
    assert_eq!(w.balance(w.treasury.id()).await?, market_fee(price));
    assert_eq!(w.balance(w.bob.id()).await?, 50 * DOLLAR - price);
    assert_eq!(w.balance(w.market.id()).await?, 0);
    assert_eq!(w.owner_of(&wallet).await?, w.bob.id().as_str());
    // The wallet's money went with the agent, and the wallet answers to Bob, frozen.
    assert_eq!(w.balance(&wallet).await?, 5 * DOLLAR);
    let view = w.wallet(&wallet).await?;
    assert_eq!(view["owner_id"], w.bob.id().as_str());
    assert_eq!(view["rotation_seq"], 1);
    assert_eq!(view["frozen"], true);
    assert!(w.listing(&wallet).await?.is_null());
    // The transfer cleared the market's approval.
    let token = w
        .view(w.registry.id(), "nft_token", json!({ "token_id": wallet }))
        .await?;
    assert_eq!(token["approved_account_ids"], json!({}));
    Ok(())
}

#[tokio::test]
async fn a_buy_at_a_stale_price_is_refunded_after_the_seller_relists_higher() -> anyhow::Result<()>
{
    let w = World::new().await?;
    let wallet = w.listed_agent(5 * DOLLAR).await?;
    // Bob saw 5; Alice re-lists at 8 before his buy lands.
    ok(w.list(&w.alice, &wallet, 8 * DOLLAR).await?)?;
    let r = w.buy(&w.bob, &wallet, 5 * DOLLAR, 5 * DOLLAR).await?;
    assert_eq!(kept(&r), 0);
    assert_eq!(refund_reason(&r), "price_changed");
    // Paying the new price while expecting the old one is refused too.
    let r = w.buy(&w.bob, &wallet, 8 * DOLLAR, 5 * DOLLAR).await?;
    assert_eq!(kept(&r), 0);
    assert_eq!(refund_reason(&r), "price_changed");
    // So is paying less than the price.
    let r = w.buy(&w.bob, &wallet, 5 * DOLLAR, 8 * DOLLAR).await?;
    assert_eq!(refund_reason(&r), "wrong_amount");
    assert_eq!(w.balance(w.bob.id()).await?, 50 * DOLLAR);
    assert_eq!(w.owner_of(&wallet).await?, w.alice.id().as_str());
    // The listing at the new price still sells.
    let r = w.buy(&w.bob, &wallet, 8 * DOLLAR, 8 * DOLLAR).await?;
    assert_eq!(kept(&r), 8 * DOLLAR);
    assert_eq!(w.owner_of(&wallet).await?, w.bob.id().as_str());
    Ok(())
}

#[tokio::test]
async fn nobody_but_the_holder_can_list_an_agent() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    let r = w.list(&w.bob, &wallet, DOLLAR).await?;
    assert_failed_with(&r, "Predecessor must be token owner");
    assert!(w.listing(&wallet).await?.is_null());
    // Prices outside (0, 1,000 credits] are refused by the market.
    for price in [0, 1_000 * DOLLAR + 1] {
        let r = w.list(&w.alice, &wallet, price).await?;
        assert!(!r.receipt_failures().is_empty());
        assert!(format!("{:?}", r.receipt_failures()).contains("invalid_price"));
        assert!(w.listing(&wallet).await?.is_null());
    }
    Ok(())
}

#[tokio::test]
async fn a_listing_is_void_once_the_token_moves_another_way() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.listed_agent(5 * DOLLAR).await?;
    w.transfer_nft(&w.alice, &wallet, &w.client).await?;
    let r = w.buy(&w.bob, &wallet, 5 * DOLLAR, 5 * DOLLAR).await?;
    assert_eq!(kept(&r), 0);
    assert_eq!(refund_reason(&r), "transfer_failed");
    assert_eq!(w.balance(w.bob.id()).await?, 50 * DOLLAR);
    assert_eq!(w.owner_of(&wallet).await?, w.client.id().as_str());
    // The failed buy left the listing buyable in principle; anyone can prune it as stale.
    assert_eq!(w.listing(&wallet).await?["sale_in_flight"], false);
    let r = w
        .stranger
        .call(w.market.id(), "prune_listing")
        .args_json(json!({ "token_id": wallet }))
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert!(r.clone().json::<bool>()?);
    assert!(w.listing(&wallet).await?.is_null());
    Ok(())
}

#[tokio::test]
async fn a_job_awarded_before_the_sale_pays_the_wallet_only_the_buyer_controls(
) -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.listed_agent(5 * DOLLAR).await?;
    w.mint_credits(w.client.id(), 10 * DOLLAR).await?;
    let job_id = w
        .delivered_job("job-sale", &wallet, 2 * DOLLAR, 2 * DOLLAR, 60_000)
        .await?;
    ok(w.buy(&w.bob, &wallet, 5 * DOLLAR, 5 * DOLLAR).await?)?;
    ok(w.jobs_call(
        &w.client,
        "accept",
        json!({ "job_id": job_id, "rating": 5 }),
    )
    .await?)?;
    let job_fee = 2 * DOLLAR * u128::from(FEE_BPS) / 10_000;
    assert_eq!(w.balance(&wallet).await?, 5 * DOLLAR + 2 * DOLLAR - job_fee);
    let r = w
        .owner_action(
            &w.alice,
            "withdraw",
            json!({ "token_id": wallet, "amount": DOLLAR.to_string() }),
            ONE_YOCTO,
        )
        .await?;
    assert_failed_with(&r, "not_owner");
    ok(w.owner_action(
        &w.bob,
        "withdraw",
        json!({ "token_id": wallet, "amount": (2 * DOLLAR).to_string() }),
        ONE_YOCTO,
    )
    .await?)?;
    assert_eq!(
        w.balance(w.bob.id()).await?,
        50 * DOLLAR - 5 * DOLLAR + 2 * DOLLAR
    );
    Ok(())
}

#[tokio::test]
async fn the_seller_keeps_no_power_over_the_agent_after_the_sale() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.listed_agent(5 * DOLLAR).await?;
    let mut loose = rulebook();
    loose["any_vendor"] = json!(true);
    w.set_rulebook(&w.alice, &wallet, loose).await?;
    // A spend over the per-call cap waits for the owner.
    let r = w
        .spend(
            &wallet,
            spend_request("held", "tool", w.vendor.id(), 3 * DOLLAR),
        )
        .await?;
    assert_eq!(outcome(&r)["status"], "pending");
    let request_id = outcome(&r)["request_id"].clone();
    // Alice re-listing replaced the market's approval; the listing follows it.
    ok(w.list(&w.alice, &wallet, 5 * DOLLAR).await?)?;
    ok(w.buy(&w.bob, &wallet, 5 * DOLLAR, 5 * DOLLAR).await?)?;

    let stored = w
        .view(&wallet, "get_outcome", json!({ "key": "held" }))
        .await?;
    assert_eq!(stored["status"], "denied");
    assert_eq!(stored["reason"], "owner_changed");
    for (method, args) in [
        (
            "approve_spend",
            json!({ "token_id": wallet, "request_id": request_id }),
        ),
        (
            "withdraw",
            json!({ "token_id": wallet, "amount": DOLLAR.to_string() }),
        ),
        (
            "set_rulebook",
            json!({ "token_id": wallet, "rulebook": rulebook() }),
        ),
        ("set_frozen", json!({ "token_id": wallet, "frozen": false })),
    ] {
        let r = w.owner_action(&w.alice, method, args, ONE_YOCTO).await?;
        assert_failed_with(&r, "not_owner");
    }
    let r = w.list(&w.alice, &wallet, DOLLAR).await?;
    assert_failed_with(&r, "Predecessor must be token owner");
    // Nor can the buyer approve what the seller's agent queued.
    let r = w
        .owner_action(
            &w.bob,
            "approve_spend",
            json!({ "token_id": wallet, "request_id": request_id }),
            ONE_YOCTO,
        )
        .await?;
    assert_failed_with(&r, "not_found");
    assert_eq!(w.balance(w.vendor.id()).await?, 0);
    assert_eq!(w.balance(&wallet).await?, 5 * DOLLAR);
    Ok(())
}

#[tokio::test]
async fn the_buyer_must_unfreeze_the_wallet_before_the_agent_can_spend() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.listed_agent(5 * DOLLAR).await?;
    ok(w.buy(&w.bob, &wallet, 5 * DOLLAR, 5 * DOLLAR).await?)?;
    let r = w
        .spend(
            &wallet,
            spend_request("after", "upkeep", w.treasury.id(), 1),
        )
        .await?;
    assert_eq!(outcome(&r)["status"], "blocked");
    assert_eq!(outcome(&r)["reason"], "frozen");
    // Bob checks the rulebook, keeps it, and unfreezes.
    w.set_rulebook(&w.bob, &wallet, rulebook()).await?;
    ok(w.owner_action(
        &w.bob,
        "set_frozen",
        json!({ "token_id": wallet, "frozen": false }),
        ONE_YOCTO,
    )
    .await?)?;
    let r = w
        .spend(
            &wallet,
            spend_request("after-2", "upkeep", w.treasury.id(), 1),
        )
        .await?;
    assert_eq!(outcome(&r)["status"], "settled");
    Ok(())
}

#[tokio::test]
async fn a_cancelled_listing_cannot_be_bought() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.listed_agent(5 * DOLLAR).await?;
    let cancel = |who: &near_workspaces::Account| {
        who.call(w.market.id(), "cancel_listing")
            .args_json(json!({ "token_id": wallet }))
            .deposit(ONE_YOCTO)
            .transact()
    };
    assert_failed_with(&cancel(&w.bob).await?, "not_seller");
    let r = cancel(&w.alice).await?;
    ok(r.clone())?;
    assert_eq!(
        event(&events(&r), "unlisted").expect("unlisted")["reason"],
        "cancelled"
    );
    ok(w.alice
        .call(w.registry.id(), "nft_revoke")
        .args_json(json!({ "token_id": wallet, "account_id": w.market.id() }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?)?;
    let r = w.buy(&w.bob, &wallet, 5 * DOLLAR, 5 * DOLLAR).await?;
    assert_eq!(kept(&r), 0);
    assert_eq!(refund_reason(&r), "not_listed");
    assert_eq!(w.balance(w.bob.id()).await?, 50 * DOLLAR);
    assert_eq!(w.owner_of(&wallet).await?, w.alice.id().as_str());
    Ok(())
}

#[tokio::test]
async fn two_buyers_race_and_exactly_one_gets_the_agent() -> anyhow::Result<()> {
    let w = World::new().await?;
    let price = 5 * DOLLAR;
    let wallet = w.listed_agent(price).await?;
    w.mint_credits(w.client.id(), 50 * DOLLAR).await?;
    let (a, b) = tokio::join!(
        w.buy(&w.bob, &wallet, price, price),
        w.buy(&w.client, &wallet, price, price)
    );
    let (a, b) = (a?, b?);
    let mut kept_amounts = [kept(&a), kept(&b)];
    kept_amounts.sort();
    assert_eq!(kept_amounts, [0, price]);
    let (winner, loser) = if kept(&a) == price {
        (&w.bob, &w.client)
    } else {
        (&w.client, &w.bob)
    };
    assert_eq!(w.owner_of(&wallet).await?, winner.id().as_str());
    assert_eq!(w.balance(winner.id()).await?, 50 * DOLLAR - price);
    assert_eq!(w.balance(loser.id()).await?, 50 * DOLLAR);
    assert_eq!(w.balance(w.alice.id()).await?, price - market_fee(price));
    assert_eq!(w.balance(w.market.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn the_seller_buying_their_own_listing_is_refunded() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.listed_agent(5 * DOLLAR).await?;
    w.mint_credits(w.alice.id(), 10 * DOLLAR).await?;
    let r = w.buy(&w.alice, &wallet, 5 * DOLLAR, 5 * DOLLAR).await?;
    assert_eq!(kept(&r), 0);
    assert_eq!(refund_reason(&r), "self_purchase");
    assert_eq!(w.balance(w.alice.id()).await?, 10 * DOLLAR);
    assert_eq!(w.balance(w.treasury.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn only_the_registry_lists_and_only_credits_pay() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    // A forged approval notice would let anyone list an agent they don't hold.
    let r = w
        .stranger
        .call(w.market.id(), "nft_on_approve")
        .args_json(json!({
            "token_id": wallet,
            "owner_id": w.stranger.id(),
            "approval_id": 1,
            "msg": json!({ "price": "1" }).to_string(),
        }))
        .transact()
        .await?;
    assert_failed_with(&r, "not_registry");
    assert!(w.listing(&wallet).await?.is_null());
    // A forged payment notice would buy without paying.
    ok(w.list(&w.alice, &wallet, DOLLAR).await?)?;
    let r = w
        .stranger
        .call(w.market.id(), "ft_on_transfer")
        .args_json(json!({
            "sender_id": w.stranger.id(),
            "amount": DOLLAR.to_string(),
            "msg": json!({ "token_id": wallet, "expected_price": DOLLAR.to_string() }).to_string(),
        }))
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed_with(&r, "wrong_token");
    assert_eq!(w.owner_of(&wallet).await?, w.alice.id().as_str());
    Ok(())
}
