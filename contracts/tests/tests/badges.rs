//! Agent badges (NEP-245): earned, held by the agent wallet account, never traded.

use hustle_integration_tests::*;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};

/// Deploys `badges.hustle.test.near` with the operator as minter and one badge type.
async fn badges(w: &World) -> anyhow::Result<Account> {
    let badges = w
        .hustle
        .create_subaccount("badges")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    ok(badges
        .deploy(&wasm("badges"))
        .await?
        .into_result()?
        .call("new")
        .args_json(json!({
            "owner_id": w.hustle.id(),
            "minter_id": w.operator.id(),
            "registry_id": w.registry.id(),
        }))
        .transact()
        .await?)?;
    ok(w.hustle
        .call(badges.id(), "register_badge")
        .args_json(json!({ "token_id": "first-job", "title": "First job", "description": "Delivered a first paid job." }))
        .transact()
        .await?)?;
    Ok(badges)
}

async fn mint(
    badges: &Account,
    caller: &Account,
    agent: &AccountId,
    token: &str,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(caller
        .call(badges.id(), "mint_badge")
        .args_json(json!({ "agent_id": agent, "token_id": token, "memo": "job 7" }))
        .transact()
        .await?)
}

async fn balance(
    w: &World,
    badges: &Account,
    agent: &AccountId,
    token: &str,
) -> anyhow::Result<Value> {
    w.view(
        badges.id(),
        "mt_balance_of",
        json!({ "account_id": agent, "token_id": token }),
    )
    .await
}

#[tokio::test]
async fn only_the_minter_mints_badges_and_only_to_agent_wallets() -> anyhow::Result<()> {
    let w = World::new().await?;
    let badges = badges(&w).await?;
    let wallet = w.mint_agent(&w.alice).await?;
    for caller in [&w.stranger, &w.alice, &w.hustle] {
        assert_failed_with(
            &mint(&badges, caller, &wallet, "first-job").await?,
            "not_minter",
        );
    }
    assert_failed_with(
        &mint(&badges, &w.operator, w.alice.id(), "first-job").await?,
        "not_agent",
    );
    assert_failed_with(
        &mint(&badges, &w.operator, &wallet, "no-such-badge").await?,
        "unknown_badge",
    );
    let r = w
        .stranger
        .call(badges.id(), "register_badge")
        .args_json(json!({ "token_id": "fake", "title": "Fake", "description": "" }))
        .transact()
        .await?;
    assert_failed_with(&r, "not_owner");
    assert_eq!(balance(&w, &badges, &wallet, "first-job").await?, "0");
    Ok(())
}

#[tokio::test]
async fn a_minted_badge_is_held_by_the_agent_wallet_with_an_mt_mint_event() -> anyhow::Result<()> {
    let w = World::new().await?;
    let badges = badges(&w).await?;
    let wallet = w.mint_agent(&w.alice).await?;
    let other = w.mint_agent(&w.bob).await?;
    let r = mint(&badges, &w.operator, &wallet, "first-job").await?;
    assert!(r.clone().json::<bool>()?);
    let event = events(&r)
        .into_iter()
        .find(|e| e["event"] == "mt_mint")
        .expect("mt_mint");
    assert_eq!(
        event,
        json!({
            "standard": "nep245",
            "version": "1.0.0",
            "event": "mt_mint",
            "data": [{ "owner_id": wallet, "token_ids": ["first-job"], "amounts": ["1"], "memo": "job 7" }],
        })
    );
    ok(mint(&badges, &w.operator, &other, "first-job").await?)?;
    assert_eq!(balance(&w, &badges, &wallet, "first-job").await?, "1");
    assert_eq!(
        w.view(badges.id(), "mt_supply", json!({ "token_id": "first-job" }))
            .await?,
        "2"
    );
    assert!(w
        .view(badges.id(), "mt_supply", json!({ "token_id": "nope" }))
        .await?
        .is_null());
    assert_eq!(
        w.view(
            badges.id(),
            "mt_batch_balance_of",
            json!({ "account_id": wallet, "token_ids": ["first-job", "nope"] })
        )
        .await?,
        json!(["1", "0"])
    );
    let token = json!({
        "token_id": "first-job",
        "owner_id": null,
        "metadata": { "title": "First job", "description": "Delivered a first paid job." },
    });
    assert_eq!(
        w.view(
            badges.id(),
            "mt_token",
            json!({ "token_ids": ["first-job", "nope"] })
        )
        .await?,
        json!([token, null])
    );
    assert_eq!(
        w.view(
            badges.id(),
            "mt_tokens_for_owner",
            json!({ "account_id": wallet })
        )
        .await?,
        json!([token])
    );
    assert_eq!(
        w.view(
            badges.id(),
            "mt_tokens_for_owner",
            json!({ "account_id": w.alice.id() })
        )
        .await?,
        json!([])
    );
    // Badges belong to the agent account, so they stay with it when the agent NFT is sold.
    w.transfer_nft(&w.alice, &wallet, &w.bob).await?;
    assert_eq!(balance(&w, &badges, &wallet, "first-job").await?, "1");
    Ok(())
}

#[tokio::test]
async fn a_second_mint_of_the_same_badge_returns_false_and_leaves_the_balance_at_one(
) -> anyhow::Result<()> {
    let w = World::new().await?;
    let badges = badges(&w).await?;
    let wallet = w.mint_agent(&w.alice).await?;
    ok(mint(&badges, &w.operator, &wallet, "first-job").await?)?;
    let again = mint(&badges, &w.operator, &wallet, "first-job").await?;
    ok(again.clone())?;
    assert!(!again.clone().json::<bool>()?);
    assert!(!has_event(&again, "mt_mint"));
    assert_eq!(balance(&w, &badges, &wallet, "first-job").await?, "1");
    assert_eq!(
        w.view(badges.id(), "mt_supply", json!({ "token_id": "first-job" }))
            .await?,
        "1"
    );
    Ok(())
}

#[tokio::test]
async fn badges_cannot_be_transferred() -> anyhow::Result<()> {
    let w = World::new().await?;
    let badges = badges(&w).await?;
    let wallet = w.mint_agent(&w.alice).await?;
    ok(mint(&badges, &w.operator, &wallet, "first-job").await?)?;
    let calls = [
        (
            "mt_transfer",
            json!({ "receiver_id": w.bob.id(), "token_id": "first-job", "amount": "1" }),
        ),
        (
            "mt_batch_transfer",
            json!({ "receiver_id": w.bob.id(), "token_ids": ["first-job"], "amounts": ["1"] }),
        ),
        (
            "mt_transfer_call",
            json!({ "receiver_id": w.bob.id(), "token_id": "first-job", "amount": "1", "msg": "" }),
        ),
        (
            "mt_batch_transfer_call",
            json!({ "receiver_id": w.bob.id(), "token_ids": ["first-job"], "amounts": ["1"], "msg": "" }),
        ),
    ];
    for (method, args) in calls {
        let r = w
            .alice
            .call(badges.id(), method)
            .args_json(args)
            .deposit(ONE_YOCTO)
            .transact()
            .await?;
        assert_failed_with(&r, "soulbound");
    }
    assert_eq!(balance(&w, &badges, &wallet, "first-job").await?, "1");
    assert_eq!(balance(&w, &badges, w.bob.id(), "first-job").await?, "0");
    Ok(())
}

#[tokio::test]
async fn badge_types_are_capped_and_size_checked() -> anyhow::Result<()> {
    let w = World::new().await?;
    let badges = badges(&w).await?;
    let register = |id: String, title: String| {
        w.hustle
            .call(badges.id(), "register_badge")
            .args_json(json!({ "token_id": id, "title": title, "description": "" }))
            .transact()
    };
    assert_failed_with(
        &register("Bad Id".into(), "x".into()).await?,
        "invalid_token_id",
    );
    assert_failed_with(
        &register("long-title".into(), "x".repeat(65)).await?,
        "invalid_title",
    );
    for i in 1..64 {
        ok(register(format!("badge-{i}"), "x".into()).await?)?;
    }
    assert_failed_with(
        &register("badge-64".into(), "x".into()).await?,
        "too_many_badges",
    );
    // Re-registering an existing type updates it and does not count against the cap.
    ok(register("first-job".into(), "First paid job".into()).await?)?;
    let config = w.view(badges.id(), "get_config", json!({})).await?;
    assert_eq!(config["badge_types"], 64);
    assert_eq!(
        w.view(badges.id(), "mt_tokens", json!({ "limit": 1 }))
            .await?[0]["metadata"]["title"],
        "First paid job"
    );
    Ok(())
}
