//! Callers who are not allowed to act are refused.

use hustle_integration_tests::*;
use near_workspaces::types::NearToken;
use serde_json::json;

#[tokio::test]
async fn a_stranger_cannot_call_the_wallet_directly() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    w.mint_credits(&wallet, 5 * DOLLAR).await?;
    let r = w
        .spend_as(
            &w.stranger,
            &wallet,
            spend_request("x", "tool", w.stranger.id(), 1),
        )
        .await?;
    assert_failed_with(&r, "not_operator");
    // Even the NFT holder must go through the registry.
    for caller in [&w.stranger, &w.alice] {
        for (method, args) in [
            (
                "rotate_owner",
                json!({ "new_owner_id": caller.id(), "rotation_seq": 9 }),
            ),
            (
                "set_rulebook",
                json!({ "rulebook": rulebook(), "rotation_seq": 0 }),
            ),
            ("approve", json!({ "request_id": 0, "rotation_seq": 0 })),
            ("deny", json!({ "request_id": 0, "rotation_seq": 0 })),
            ("set_frozen", json!({ "frozen": true, "rotation_seq": 0 })),
            (
                "withdraw",
                json!({ "amount": "1", "receiver_id": caller.id(), "rotation_seq": 0 }),
            ),
        ] {
            let r = caller
                .call(&wallet, method)
                .args_json(args)
                .gas(MAX_GAS)
                .transact()
                .await?;
            assert_failed_with(&r, "not_registry");
        }
    }
    let r = w
        .stranger
        .call(&wallet, "new")
        .args_json(json!({
            "owner_id": w.stranger.id(), "operator_id": w.stranger.id(), "credits_id": w.credits.id(),
            "jobs_id": w.jobs.id(), "treasury_id": w.stranger.id(), "rulebook": null, "day_ms": 60_000,
        }))
        .transact()
        .await?;
    assert!(r.is_failure());
    assert_eq!(w.wallet(&wallet).await?["owner_id"], w.alice.id().as_str());
    Ok(())
}

#[tokio::test]
async fn only_the_minter_can_mint() -> anyhow::Result<()> {
    let w = World::new().await?;
    let deposit = w.mint_deposit().await?;
    for caller in [&w.stranger, &w.alice, &w.hustle] {
        let r = caller
            .call(w.registry.id(), "mint_agent")
            .args_json(json!({ "owner_id": caller.id(), "name": "Mine", "metadata": null, "rulebook": null }))
            .deposit(deposit)
            .gas(MAX_GAS)
            .transact()
            .await?;
        assert_failed_with(&r, "not_minter");
    }
    let r = w
        .stranger
        .call(w.registry.id(), "set_wallet_code")
        .args(vec![0, 97, 115, 109])
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_failed_with(&r, "not_owner");
    Ok(())
}

#[tokio::test]
async fn a_stranger_cannot_act_for_the_owner_through_the_registry() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    let r = w
        .owner_action(
            &w.stranger,
            "withdraw",
            json!({ "token_id": wallet, "amount": "1" }),
            ONE_YOCTO,
        )
        .await?;
    assert_failed_with(&r, "not_owner");
    Ok(())
}

#[tokio::test]
async fn owner_actions_without_exactly_one_yocto_fail() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    for deposit in [NearToken::from_yoctonear(0), NearToken::from_yoctonear(2)] {
        for (method, args) in [
            (
                "set_rulebook",
                json!({ "token_id": wallet, "rulebook": rulebook() }),
            ),
            (
                "approve_spend",
                json!({ "token_id": wallet, "request_id": 0 }),
            ),
            ("deny_spend", json!({ "token_id": wallet, "request_id": 0 })),
            ("withdraw", json!({ "token_id": wallet, "amount": "1" })),
            ("set_frozen", json!({ "token_id": wallet, "frozen": true })),
        ] {
            let r = w.owner_action(&w.alice, method, args, deposit).await?;
            assert_failed_with(&r, "exactly 1 yoctoNEAR");
        }
    }
    let r = w
        .alice
        .call(w.registry.id(), "nft_transfer")
        .args_json(json!({ "receiver_id": w.bob.id(), "token_id": wallet }))
        .transact()
        .await?;
    assert_failed_with(&r, "exactly 1 yoctoNEAR");
    Ok(())
}

#[tokio::test]
async fn only_credits_can_call_ft_on_transfer_on_the_job_board() -> anyhow::Result<()> {
    let w = World::new().await?;
    let msg = json!({ "post": { "job_key": "fake", "spec_hash": "h", "auto_award": false, "review_window_ms": 0 } });
    let r = w
        .jobs_call(
            &w.stranger,
            "ft_on_transfer",
            json!({ "sender_id": w.stranger.id(), "amount": "1000000000", "msg": msg.to_string() }),
        )
        .await?;
    assert_failed_with(&r, "wrong_token");
    assert!(w.job_by_key("fake").await?.is_null());
    Ok(())
}

#[tokio::test]
async fn only_the_job_board_can_record_reputation() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    for caller in [&w.stranger, &w.operator] {
        let r = caller
            .call(w.rep.id(), "record")
            .args_json(
                json!({ "agent_id": wallet, "job_id": "1", "outcome": "completed", "rating": 5 }),
            )
            .transact()
            .await?;
        assert_failed_with(&r, "not_jobs");
    }
    let r = w
        .stranger
        .call(w.rep.id(), "record_scam_blocked")
        .args_json(json!({ "agent_id": wallet, "job_id": "1" }))
        .transact()
        .await?;
    assert_failed_with(&r, "not_operator");
    ok(w.operator
        .call(w.rep.id(), "record_scam_blocked")
        .args_json(json!({ "agent_id": wallet, "job_id": "1" }))
        .deposit(NearToken::from_millinear(24))
        .transact()
        .await?)?;
    let rep = w
        .view(w.rep.id(), "get_reputation", json!({ "agent_id": wallet }))
        .await?;
    assert_eq!(rep["scams_blocked"], 1);
    assert_eq!(rep["rated_jobs"], 0);
    Ok(())
}

#[tokio::test]
async fn only_the_operator_can_deliver_and_only_the_client_can_accept() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    w.mint_credits(w.client.id(), 10 * DOLLAR).await?;
    ok(w.post_job(&w.client, "job-a", 2 * DOLLAR, false, 60_000)
        .await?)?;
    let r = w
        .jobs_call(
            &w.operator,
            "award",
            json!({ "job_id": 0, "agent_id": wallet, "price": "1000000" }),
        )
        .await?;
    assert_failed_with(&r, "not_client");
    ok(w.jobs_call(
        &w.client,
        "award",
        json!({ "job_id": 0, "agent_id": wallet, "price": "1000000" }),
    )
    .await?)?;
    for caller in [&w.client, &w.alice, &w.stranger] {
        let r = w
            .jobs_call(
                caller,
                "deliver",
                json!({ "job_id": 0, "agent_id": wallet, "work_hash": "h" }),
            )
            .await?;
        assert_failed_with(&r, "not_operator");
    }
    ok(w.jobs_call(
        &w.operator,
        "deliver",
        json!({ "job_id": 0, "agent_id": wallet, "work_hash": "h" }),
    )
    .await?)?;
    for caller in [&w.stranger, &w.operator, &w.alice] {
        let r = w
            .jobs_call(caller, "accept", json!({ "job_id": 0, "rating": 5 }))
            .await?;
        assert_failed_with(&r, "not_client");
        let r = w
            .jobs_call(caller, "dispute", json!({ "job_id": 0 }))
            .await?;
        assert_failed_with(&r, "not_client");
    }
    let r = w
        .jobs_call(&w.client, "resolve", json!({ "job_id": 0, "refund": true }))
        .await?;
    assert_failed_with(&r, "not_operator");
    Ok(())
}
