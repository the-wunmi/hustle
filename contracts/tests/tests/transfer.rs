//! Selling an agent: the NFT moves, the wallet's money and history stay, control moves with it.

use hustle_integration_tests::*;
use serde_json::json;

#[tokio::test]
async fn a_job_awarded_under_the_old_owner_pays_the_agent_wallet_after_transfer(
) -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    w.mint_credits(w.client.id(), 10 * DOLLAR).await?;
    let job_id = w
        .delivered_job("job-a", &wallet, 2 * DOLLAR, 2 * DOLLAR, 60_000)
        .await?;
    w.transfer_nft(&w.alice, &wallet, &w.bob).await?;
    ok(w.jobs_call(
        &w.client,
        "accept",
        json!({ "job_id": job_id, "rating": 5 }),
    )
    .await?)?;
    let fee = 2 * DOLLAR * u128::from(FEE_BPS) / 10_000;
    assert_eq!(w.balance(&wallet).await?, 2 * DOLLAR - fee);
    assert_eq!(w.balance(w.alice.id()).await?, 0);
    assert_eq!(w.balance(w.bob.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn the_old_owner_loses_every_owner_action_after_transfer() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    w.mint_credits(&wallet, 5 * DOLLAR).await?;
    w.transfer_nft(&w.alice, &wallet, &w.bob).await?;
    for (method, args) in [
        (
            "withdraw",
            json!({ "token_id": wallet, "amount": DOLLAR.to_string() }),
        ),
        (
            "set_rulebook",
            json!({ "token_id": wallet, "rulebook": rulebook() }),
        ),
        (
            "approve_spend",
            json!({ "token_id": wallet, "request_id": 0 }),
        ),
        ("deny_spend", json!({ "token_id": wallet, "request_id": 0 })),
        ("set_frozen", json!({ "token_id": wallet, "frozen": true })),
    ] {
        let r = w.owner_action(&w.alice, method, args, ONE_YOCTO).await?;
        assert_failed_with(&r, "not_owner");
    }
    assert_eq!(w.balance(&wallet).await?, 5 * DOLLAR);
    Ok(())
}

#[tokio::test]
async fn pending_approvals_are_cleared_on_transfer() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    w.mint_credits(&wallet, 5 * DOLLAR).await?;
    let r = w
        .spend(&wallet, spend_request("big", "upkeep", w.treasury.id(), 1))
        .await?;
    assert_eq!(outcome(&r)["status"], "settled");
    let mut rb = rulebook();
    rb["any_vendor"] = json!(true);
    w.set_rulebook(&w.alice, &wallet, rb).await?;
    let r = w
        .spend(
            &wallet,
            spend_request("held", "tool", w.vendor.id(), 3 * DOLLAR),
        )
        .await?;
    assert_eq!(outcome(&r)["status"], "pending");

    w.transfer_nft(&w.alice, &wallet, &w.bob).await?;
    let view = w.wallet(&wallet).await?;
    assert!(view["pending"].as_array().unwrap().is_empty());
    assert_eq!(view["owner_id"], w.bob.id().as_str());
    assert_eq!(view["rotation_seq"], 1);
    // A new owner starts frozen and unfreezes once they have checked the rulebook.
    assert_eq!(view["frozen"], true);
    let stored = w
        .view(&wallet, "get_outcome", json!({ "key": "held" }))
        .await?;
    assert_eq!(
        stored,
        json!({ "status": "denied", "request_id": 1, "reason": "owner_changed" })
    );
    // The new owner cannot approve what the old owner's agent queued.
    let r = w
        .owner_action(
            &w.bob,
            "approve_spend",
            json!({ "token_id": wallet, "request_id": 1 }),
            ONE_YOCTO,
        )
        .await?;
    assert_failed_with(&r, "not_found");
    assert_eq!(w.balance(w.vendor.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn the_new_owner_can_withdraw_and_withdraw_always_pays_the_current_holder(
) -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    w.mint_credits(&wallet, 5 * DOLLAR).await?;
    let r = w
        .owner_action(
            &w.alice,
            "withdraw",
            json!({ "token_id": wallet, "amount": DOLLAR.to_string() }),
            ONE_YOCTO,
        )
        .await?;
    assert!(r.clone().json::<bool>()?);
    assert!(has_event(&r, "withdrawn"));
    assert_eq!(w.balance(w.alice.id()).await?, DOLLAR);

    w.transfer_nft(&w.alice, &wallet, &w.bob).await?;
    ok(w.owner_action(
        &w.bob,
        "withdraw",
        json!({ "token_id": wallet, "amount": (2 * DOLLAR).to_string() }),
        ONE_YOCTO,
    )
    .await?)?;
    assert_eq!(w.balance(w.bob.id()).await?, 2 * DOLLAR);
    assert_eq!(w.balance(w.alice.id()).await?, DOLLAR);
    assert_eq!(w.balance(&wallet).await?, 2 * DOLLAR);
    Ok(())
}

#[tokio::test]
async fn the_registry_and_the_wallet_agree_on_the_owner_after_transfer() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    w.transfer_nft(&w.alice, &wallet, &w.bob).await?;
    let from_registry = w
        .view(
            w.registry.id(),
            "nft_item_info",
            json!({ "token_id": wallet }),
        )
        .await?;
    let from_wallet = w.view(&wallet, "nft_item_info", json!({})).await?;
    assert_eq!(from_registry, from_wallet);
    assert_eq!(
        from_wallet,
        json!({
            "spec": "sharded-item-1.0.0",
            "collection_id": w.registry.id(),
            "token_id": wallet,
            "owner_id": w.bob.id(),
            "rotation_seq": 1,
        })
    );
    // Resending the rotation is harmless.
    ok(w.stranger
        .call(w.registry.id(), "sync_owner")
        .args_json(json!({ "token_id": wallet }))
        .gas(MAX_GAS)
        .transact()
        .await?)?;
    assert_eq!(w.wallet(&wallet).await?["rotation_seq"], 1);
    Ok(())
}

/// The receiver of `nft_transfer_call` holds the token provisionally while `nft_on_transfer` runs.
/// A hostile receiver tries to withdraw and loosen the rulebook in that window, then hands the token
/// back; the registry refuses owner actions while the transfer is unresolved.
#[tokio::test]
async fn a_transfer_call_receiver_cannot_act_as_owner_before_it_keeps_the_token(
) -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    w.mint_credits(&wallet, 5 * DOLLAR).await?;
    let receiver = w
        .worker
        .root_account()?
        .create_subaccount("receiver")
        .initial_balance(near_workspaces::types::NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    // No init needed: the fixture has default state.
    receiver
        .deploy(&wasm("fixtures/nft-receiver"))
        .await?
        .into_result()?;
    w.register(receiver.id()).await?;
    let r = w
        .alice
        .call(w.registry.id(), "nft_transfer_call")
        .args_json(json!({
            "receiver_id": receiver.id(),
            "token_id": wallet,
            "msg": (5 * DOLLAR).to_string(),
        }))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert!(r.is_success());
    // Both attack calls were refused, and the token came back.
    let refusals = r
        .receipt_failures()
        .iter()
        .filter(|f| format!("{f:?}").contains("transfer_in_flight"))
        .count();
    assert_eq!(refusals, 2);
    assert!(!r.clone().json::<bool>()?);
    let token = w
        .view(w.registry.id(), "nft_token", json!({ "token_id": wallet }))
        .await?;
    assert_eq!(token["owner_id"], w.alice.id().as_str());
    assert_eq!(w.balance(&wallet).await?, 5 * DOLLAR);
    assert_eq!(w.balance(receiver.id()).await?, 0);
    let view = w.wallet(&wallet).await?;
    assert_eq!(view["rulebook"], rulebook());
    assert_eq!(view["rotation_seq"], 0);
    // The guard is lifted once the transfer resolves.
    assert_eq!(
        w.view(
            w.registry.id(),
            "is_transfer_in_flight",
            json!({ "token_id": wallet })
        )
        .await?,
        false
    );
    ok(w.owner_action(
        &w.alice,
        "withdraw",
        json!({ "token_id": wallet, "amount": "1" }),
        ONE_YOCTO,
    )
    .await?)?;
    Ok(())
}
