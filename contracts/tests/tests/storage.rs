//! Storage stays paid for and bounded.

use hustle_integration_tests::*;
use near_workspaces::types::NearToken;
use serde_json::json;

#[tokio::test]
async fn a_mint_by_anyone_but_the_minter_or_without_the_deposit_fails() -> anyhow::Result<()> {
    let w = World::new().await?;
    let deposit = w.mint_deposit().await?;
    let r = w
        .stranger
        .call(w.registry.id(), "mint_agent")
        .args_json(
            json!({ "owner_id": w.stranger.id(), "name": "x", "metadata": null, "rulebook": null }),
        )
        .deposit(deposit)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed_with(&r, "not_minter");
    let r = w
        .minter
        .call(w.registry.id(), "mint_agent")
        .args_json(
            json!({ "owner_id": w.alice.id(), "name": "x", "metadata": null, "rulebook": null }),
        )
        .deposit(deposit.saturating_sub(NearToken::from_yoctonear(1)))
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed_with(&r, "insufficient_deposit");
    assert_eq!(
        w.view(w.registry.id(), "nft_total_supply", json!({}))
            .await?,
        "0"
    );
    Ok(())
}

#[tokio::test]
async fn a_minted_agent_is_a_keyless_funded_wallet_registered_on_credits() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    assert_eq!(wallet.as_str(), format!("agent-0.{}", w.registry.id()));
    let keys = w.worker.view_access_keys(&wallet).await?;
    assert!(keys.is_empty(), "wallet must have no access keys");
    let token = w
        .view(w.registry.id(), "nft_token", json!({ "token_id": wallet }))
        .await?;
    assert_eq!(token["owner_id"], w.alice.id().as_str());
    assert_eq!(token["metadata"]["title"], "Scout");
    assert!(!w
        .view(
            w.credits.id(),
            "storage_balance_of",
            json!({ "account_id": wallet })
        )
        .await?
        .is_null());
    let view = w.wallet(&wallet).await?;
    assert_eq!(view["rulebook"], rulebook());
    // A mint without a rulebook gets the locked one: nothing can be spent.
    let locked = w.mint_agent_with(&w.bob, None).await?;
    assert_eq!(w.wallet(&locked).await?["rulebook"]["daily_cap"], "0");
    Ok(())
}

#[tokio::test]
async fn a_mint_whose_wallet_cannot_be_created_mints_no_token_and_refunds_the_minter(
) -> anyhow::Result<()> {
    let w = World::new().await?;
    // Wallet code whose `new` rejects the registry's arguments: the creation batch fails.
    ok(w.hustle
        .call(w.registry.id(), "set_wallet_code")
        .args(wasm("reputation"))
        .gas(MAX_GAS)
        .transact()
        .await?)?;
    let before = w.minter.view_account().await?.balance;
    let deposit = w.mint_deposit().await?;
    let r = w
        .minter
        .call(w.registry.id(), "mint_agent")
        .args_json(
            json!({ "owner_id": w.alice.id(), "name": "x", "metadata": null, "rulebook": null }),
        )
        .deposit(deposit)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert!(r.is_success());
    assert_eq!(r.clone().json::<Option<String>>()?, None);
    assert!(has_event(&r, "mint_failed"));
    assert_eq!(
        w.view(w.registry.id(), "nft_total_supply", json!({}))
            .await?,
        "0"
    );
    let ghost: near_workspaces::AccountId = format!("agent-0.{}", w.registry.id()).parse()?;
    assert!(w.worker.view_account(&ghost).await.is_err());
    // Only gas and the credits registration are lost.
    let spent = before.saturating_sub(w.minter.view_account().await?.balance);
    assert!(
        spent < NearToken::from_millinear(100),
        "minter lost {spent}"
    );
    Ok(())
}

#[tokio::test]
async fn settled_jobs_are_removed_from_storage() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    w.mint_credits(w.client.id(), 10 * DOLLAR).await?;
    let job = w
        .delivered_job("job-a", &wallet, 2 * DOLLAR, 2 * DOLLAR, 60_000)
        .await?;
    assert_eq!(w.view(w.jobs.id(), "get_job_count", json!({})).await?, 1);
    ok(
        w.jobs_call(&w.client, "accept", json!({ "job_id": job, "rating": 3 }))
            .await?,
    )?;
    assert_eq!(w.view(w.jobs.id(), "get_job_count", json!({})).await?, 0);
    assert!(w.job(job).await?.is_null());
    assert!(w.job_by_key("job-a").await?.is_null());
    assert_eq!(w.view(w.jobs.id(), "get_jobs", json!({})).await?, json!([]));
    Ok(())
}

#[tokio::test]
async fn the_wallets_rings_and_queues_stay_bounded() -> anyhow::Result<()> {
    let w = World::new().await?;
    let mut rb = rulebook();
    rb["allowed_vendors"] = json!([w.vendor.id()]);
    let wallet = w.mint_agent_with(&w.alice, Some(rb)).await?;
    w.mint_credits(&wallet, 10 * DOLLAR).await?;
    // 17 jobs with spend: the per-job ring keeps the last 16.
    for i in 0..17 {
        let r = w
            .spend(
                &wallet,
                with_job(
                    spend_request(&format!("t{i}"), "tool", w.vendor.id(), 1),
                    &format!("job-{i}"),
                ),
            )
            .await?;
        assert_eq!(outcome(&r)["status"], "settled");
    }
    // Over-cap requests: the pending queue stops at 8.
    for i in 0..10 {
        let _ = w
            .spend(
                &wallet,
                spend_request(&format!("p{i}"), "tool", w.vendor.id(), 3 * DOLLAR),
            )
            .await?;
    }
    // Blocked requests fill the idempotency ring past its size.
    for i in 0..40 {
        let _ = w
            .spend(
                &wallet,
                spend_request(&format!("b{i}"), "tool", w.scammer.id(), 1),
            )
            .await?;
    }
    let view = w.wallet(&wallet).await?;
    let job_spend = view["job_spend"].as_array().unwrap();
    assert_eq!(job_spend.len(), 16);
    assert_eq!(job_spend[0]["job_id"], "job-1");
    assert_eq!(view["pending"].as_array().unwrap().len(), 8);
    let recent = view["recent"].as_array().unwrap();
    assert_eq!(recent.len(), 64);
    assert_eq!(recent[63]["key"], "b39");
    // The wallet's storage stays within what the registry funded at mint.
    let account = w.worker.view_account(&wallet).await?;
    let code_len = wasm("agent-wallet").len() as u64;
    assert!(
        account.storage_usage < code_len + 24_200,
        "storage {}",
        account.storage_usage
    );
    Ok(())
}

#[tokio::test]
async fn a_scam_report_that_creates_a_reputation_entry_must_pay_for_its_storage(
) -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    let config = w.view(w.rep.id(), "get_config", json!({})).await?;
    let required: u128 = config["new_entry_deposit"].as_str().unwrap().parse()?;
    assert_eq!(required, 24_000_000_000_000_000_000_000);
    let report = |deposit: u128, agent: near_workspaces::AccountId| {
        w.operator
            .call(w.rep.id(), "record_scam_blocked")
            .args_json(json!({ "agent_id": agent, "job_id": "7" }))
            .deposit(NearToken::from_yoctonear(deposit))
            .transact()
    };
    // Any agent-shaped id, existing or not, needs the deposit for its first entry.
    let ghost: near_workspaces::AccountId = format!("agent-999.{}", w.registry.id()).parse()?;
    assert_failed_with(&report(0, ghost.clone()).await?, "insufficient_deposit");
    assert_failed_with(
        &report(required - 1, wallet.clone()).await?,
        "insufficient_deposit",
    );
    ok(report(required, wallet.clone()).await?)?;
    // Later reports for the same agent update the paid entry and need no deposit.
    ok(report(0, wallet.clone()).await?)?;
    let rep = w
        .view(w.rep.id(), "get_reputation", json!({ "agent_id": wallet }))
        .await?;
    assert_eq!(rep["scams_blocked"], 2);
    assert!(w
        .view(w.rep.id(), "get_reputation", json!({ "agent_id": ghost }))
        .await?
        .is_null());
    Ok(())
}
