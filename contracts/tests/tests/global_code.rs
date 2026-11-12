//! The wallet code published once as a global contract: new agents use it by hash instead of each
//! paying for a copy, and agents minted before keep their own copy and keep working.

use hustle_integration_tests::*;
use near_workspaces::types::NearToken;
use serde_json::json;

fn global_cost() -> NearToken {
    // 10x the code's storage at 10^19 yoctoNEAR a byte.
    NearToken::from_yoctonear(wasm("agent-wallet").len() as u128 * 10 * 10u128.pow(19))
}

async fn publish(
    w: &World,
    deposit: NearToken,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(w.hustle
        .call(w.registry.id(), "publish_wallet_code")
        .args(wasm("agent-wallet"))
        .deposit(deposit)
        .gas(MAX_GAS)
        .transact()
        .await?)
}

async fn config(w: &World) -> anyhow::Result<serde_json::Value> {
    w.view(w.registry.id(), "get_config", json!({})).await
}

#[tokio::test]
async fn only_the_owner_publishes_only_the_stored_code_with_its_cost_paid() -> anyhow::Result<()> {
    let w = World::new().await?;
    let r = w
        .stranger
        .call(w.registry.id(), "publish_wallet_code")
        .args(wasm("agent-wallet"))
        .deposit(global_cost())
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed_with(&r, "not_owner");
    let r = w
        .hustle
        .call(w.registry.id(), "publish_wallet_code")
        .args(wasm("reputation"))
        .deposit(global_cost())
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed_with(&r, "not_the_wallet_code");
    let r = publish(
        &w,
        global_cost().saturating_sub(NearToken::from_yoctonear(1)),
    )
    .await?;
    assert_failed_with(&r, "insufficient_deposit");
    assert_eq!(config(&w).await?["wallet_code_global"], false);
    Ok(())
}

#[tokio::test]
async fn after_publishing_a_mint_costs_a_fraction_and_old_and_new_wallets_both_work(
) -> anyhow::Result<()> {
    let w = World::new().await?;
    let before_publish = w.mint_deposit().await?;
    let minter_start = w.minter.view_account().await?.balance;
    let old = w.mint_agent(&w.alice).await?;
    let old_cost = minter_start.saturating_sub(w.minter.view_account().await?.balance);

    let owner_before = w.hustle.view_account().await?.balance;
    let r = publish(&w, global_cost().saturating_add(NearToken::from_near(1))).await?;
    ok(r.clone())?;
    assert!(has_event(&r, "wallet_code_published"));
    assert_eq!(config(&w).await?["wallet_code_global"], true);
    // The owner paid the burn and gas; the extra NEAR came back.
    let paid = owner_before.saturating_sub(w.hustle.view_account().await?.balance);
    assert!(
        paid >= global_cost()
            && paid < global_cost().saturating_add(NearToken::from_millinear(100)),
        "paid {paid}"
    );
    let r = publish(&w, global_cost()).await?;
    assert_failed_with(&r, "already_published");

    let after_publish = w.mint_deposit().await?;
    assert!(
        after_publish < NearToken::from_millinear(400),
        "mint deposit with global code: {after_publish}"
    );
    assert!(
        after_publish.saturating_mul(5) < before_publish,
        "{after_publish} vs {before_publish}"
    );

    let minter_before = w.minter.view_account().await?.balance;
    let new = w.mint_agent(&w.bob).await?;
    let mint_cost = minter_before.saturating_sub(w.minter.view_account().await?.balance);
    eprintln!("mint cost: own copy {old_cost}, global code {mint_cost}");
    assert!(
        mint_cost < NearToken::from_millinear(500),
        "a mint now costs {mint_cost}"
    );
    assert!(
        mint_cost.saturating_mul(4) < old_cost,
        "{mint_cost} vs {old_cost}"
    );
    assert!(
        w.worker.view_access_keys(&new).await?.is_empty(),
        "wallet must stay keyless"
    );
    // The new wallet stores no code of its own: its state fits in what it was funded for.
    let account = w.worker.view_account(&new).await?;
    assert!(
        account.storage_usage < 30_000,
        "storage {}",
        account.storage_usage
    );

    // Both wallets enforce the rulebook and pay a vendor on it.
    for wallet in [&old, &new] {
        w.mint_credits(wallet, 10 * DOLLAR).await?;
        let mut rb = rulebook();
        rb["allowed_vendors"] = json!([w.vendor.id()]);
        let owner = if wallet == &old { &w.alice } else { &w.bob };
        w.set_rulebook(owner, wallet, rb).await?;
        let r = w
            .spend(
                wallet,
                spend_request(&format!("t-{wallet}"), "tool", w.vendor.id(), DOLLAR),
            )
            .await?;
        ok(r.clone())?;
        assert_eq!(outcome(&r)["status"], "settled");
        let r = w
            .spend(
                wallet,
                spend_request(&format!("s-{wallet}"), "tool", w.scammer.id(), DOLLAR),
            )
            .await?;
        assert_eq!(outcome(&r)["status"], "blocked");
    }
    Ok(())
}

#[tokio::test]
async fn new_wallet_code_is_not_global_until_it_is_published_again() -> anyhow::Result<()> {
    let w = World::new().await?;
    ok(publish(&w, global_cost()).await?)?;
    assert_eq!(config(&w).await?["wallet_code_global"], true);
    ok(w.hustle
        .call(w.registry.id(), "set_wallet_code")
        .args(wasm("agent-wallet"))
        .gas(MAX_GAS)
        .transact()
        .await?)?;
    assert_eq!(config(&w).await?["wallet_code_global"], false);
    // Mints still work, with their own copy again.
    let wallet = w.mint_agent(&w.alice).await?;
    assert!(w.worker.view_account(&wallet).await?.storage_usage > 100_000);
    Ok(())
}
