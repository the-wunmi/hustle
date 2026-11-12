//! The agent wallet's rulebook, enforced against the operator.

use hustle_integration_tests::*;
use near_workspaces::AccountId;
use serde_json::{json, Value};

async fn agent_with(w: &World, rulebook: Value) -> anyhow::Result<AccountId> {
    let wallet = w.mint_agent_with(&w.alice, Some(rulebook)).await?;
    w.mint_credits(&wallet, 50 * DOLLAR).await?;
    Ok(wallet)
}

fn allowlist(w: &World) -> Value {
    let mut rb = rulebook();
    rb["allowed_vendors"] = json!([w.vendor.id()]);
    rb
}

#[tokio::test]
async fn a_tool_payment_to_a_vendor_off_the_allowlist_is_blocked_and_moves_no_money(
) -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = agent_with(&w, allowlist(&w)).await?;
    let result = w
        .spend(
            &wallet,
            spend_request("scam-1", "tool", w.scammer.id(), DOLLAR),
        )
        .await?;
    // A blocked spend returns normally so its event stays on-chain.
    ok(result.clone())?;
    assert_eq!(
        outcome(&result),
        json!({ "status": "blocked", "request_id": 0, "reason": "vendor_not_allowed" })
    );
    assert!(has_event(&result, "spend_blocked"));
    assert_eq!(w.balance(w.scammer.id()).await?, 0);
    assert_eq!(w.balance(&wallet).await?, 50 * DOLLAR);
    Ok(())
}

#[tokio::test]
async fn any_vendor_mode_lets_the_same_payment_through() -> anyhow::Result<()> {
    let w = World::new().await?;
    let mut rb = allowlist(&w);
    rb["any_vendor"] = json!(true);
    let wallet = agent_with(&w, rb).await?;
    let result = w
        .spend(
            &wallet,
            spend_request("scam-1", "tool", w.scammer.id(), DOLLAR),
        )
        .await?;
    assert_eq!(outcome(&result)["status"], "settled");
    assert!(has_event(&result, "spend_settled"));
    assert_eq!(w.balance(w.scammer.id()).await?, DOLLAR);
    Ok(())
}

#[tokio::test]
async fn a_payment_over_max_per_call_waits_for_the_owner() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = agent_with(&w, allowlist(&w)).await?;
    let result = w
        .spend(
            &wallet,
            spend_request("big", "tool", w.vendor.id(), 3 * DOLLAR),
        )
        .await?;
    assert_eq!(
        outcome(&result),
        json!({ "status": "pending", "request_id": 0, "reason": "over_call_cap" })
    );
    assert!(has_event(&result, "approval_requested"));
    assert_eq!(
        w.wallet(&wallet).await?["pending"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(w.balance(w.vendor.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn spend_past_max_per_job_waits_for_the_owner() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = agent_with(&w, allowlist(&w)).await?;
    for key in ["a", "b"] {
        let r = w
            .spend(
                &wallet,
                with_job(
                    spend_request(key, "tool", w.vendor.id(), 2 * DOLLAR),
                    "job-1",
                ),
            )
            .await?;
        assert_eq!(outcome(&r)["status"], "settled");
    }
    let r = w
        .spend(
            &wallet,
            with_job(
                spend_request("c", "tool", w.vendor.id(), 2 * DOLLAR),
                "job-1",
            ),
        )
        .await?;
    assert_eq!(outcome(&r)["reason"], "over_job_cap");
    assert_eq!(outcome(&r)["status"], "pending");
    // Another job has its own allowance.
    let r = w
        .spend(
            &wallet,
            with_job(
                spend_request("d", "tool", w.vendor.id(), 2 * DOLLAR),
                "job-2",
            ),
        )
        .await?;
    assert_eq!(outcome(&r)["status"], "settled");
    Ok(())
}

#[tokio::test]
async fn spend_past_the_daily_cap_waits_for_the_owner() -> anyhow::Result<()> {
    let w = World::new().await?;
    let mut rb = allowlist(&w);
    rb["daily_cap"] = json!((3 * DOLLAR).to_string());
    let wallet = agent_with(&w, rb).await?;
    let r = w
        .spend(
            &wallet,
            spend_request("a", "tool", w.vendor.id(), 2 * DOLLAR),
        )
        .await?;
    assert_eq!(outcome(&r)["status"], "settled");
    let r = w
        .spend(
            &wallet,
            spend_request("b", "tool", w.vendor.id(), 2 * DOLLAR),
        )
        .await?;
    assert_eq!(
        outcome(&r),
        json!({ "status": "pending", "request_id": 1, "reason": "over_daily_cap" })
    );
    Ok(())
}

#[tokio::test]
async fn the_owner_approving_a_held_payment_executes_it() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = agent_with(&w, allowlist(&w)).await?;
    ok(w.spend(
        &wallet,
        spend_request("big", "tool", w.vendor.id(), 3 * DOLLAR),
    )
    .await?)?;
    let result = w
        .owner_action(
            &w.alice,
            "approve_spend",
            json!({ "token_id": wallet, "request_id": 0 }),
            ONE_YOCTO,
        )
        .await?;
    assert_eq!(
        outcome(&result),
        json!({ "status": "settled", "request_id": 0 })
    );
    assert_eq!(w.balance(w.vendor.id()).await?, 3 * DOLLAR);
    let view = w.wallet(&wallet).await?;
    assert!(view["pending"].as_array().unwrap().is_empty());
    assert_eq!(view["spent_today"], (3 * DOLLAR).to_string());
    let stored = w
        .view(&wallet, "get_outcome", json!({ "key": "big" }))
        .await?;
    assert_eq!(stored["status"], "settled");
    Ok(())
}

#[tokio::test]
async fn approval_still_applies_the_receiver_rule() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = agent_with(&w, allowlist(&w)).await?;
    ok(w.spend(
        &wallet,
        spend_request("big", "tool", w.vendor.id(), 3 * DOLLAR),
    )
    .await?)?;
    // The owner tightens the allowlist before approving.
    w.set_rulebook(&w.alice, &wallet, rulebook()).await?;
    let result = w
        .owner_action(
            &w.alice,
            "approve_spend",
            json!({ "token_id": wallet, "request_id": 0 }),
            ONE_YOCTO,
        )
        .await?;
    assert_eq!(outcome(&result)["reason"], "vendor_not_allowed");
    assert_eq!(w.balance(w.vendor.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn the_owner_denying_a_held_payment_drops_it() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = agent_with(&w, allowlist(&w)).await?;
    ok(w.spend(
        &wallet,
        spend_request("big", "tool", w.vendor.id(), 3 * DOLLAR),
    )
    .await?)?;
    let result = w
        .owner_action(
            &w.alice,
            "deny_spend",
            json!({ "token_id": wallet, "request_id": 0 }),
            ONE_YOCTO,
        )
        .await?;
    assert_eq!(
        outcome(&result),
        json!({ "status": "denied", "request_id": 0, "reason": "denied_by_owner" })
    );
    assert!(has_event(&result, "approval_denied"));
    assert!(w.wallet(&wallet).await?["pending"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(w.balance(w.vendor.id()).await?, 0);
    // The request is gone: approving it now fails.
    let again = w
        .owner_action(
            &w.alice,
            "approve_spend",
            json!({ "token_id": wallet, "request_id": 0 }),
            ONE_YOCTO,
        )
        .await?;
    assert_failed_with(&again, "not_found");
    Ok(())
}

#[tokio::test]
async fn a_full_approval_queue_blocks_further_over_cap_spends() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = agent_with(&w, allowlist(&w)).await?;
    for i in 0..8 {
        let r = w
            .spend(
                &wallet,
                spend_request(&format!("big-{i}"), "tool", w.vendor.id(), 3 * DOLLAR),
            )
            .await?;
        assert_eq!(outcome(&r)["status"], "pending");
    }
    let r = w
        .spend(
            &wallet,
            spend_request("big-8", "tool", w.vendor.id(), 3 * DOLLAR),
        )
        .await?;
    assert_eq!(
        outcome(&r),
        json!({ "status": "blocked", "request_id": 8, "reason": "approval_queue_full" })
    );
    assert_eq!(
        w.wallet(&wallet).await?["pending"]
            .as_array()
            .unwrap()
            .len(),
        8
    );
    Ok(())
}

#[tokio::test]
async fn inference_over_the_daily_cap_is_blocked_not_queued() -> anyhow::Result<()> {
    let w = World::new().await?;
    let mut rb = rulebook();
    rb["daily_cap"] = json!((3 * DOLLAR).to_string());
    let wallet = agent_with(&w, rb).await?;
    let r = w
        .spend(
            &wallet,
            spend_request("i1", "inference", w.treasury.id(), 2 * DOLLAR),
        )
        .await?;
    assert_eq!(outcome(&r)["status"], "settled");
    let r = w
        .spend(
            &wallet,
            spend_request("i2", "inference", w.treasury.id(), 2 * DOLLAR),
        )
        .await?;
    assert_eq!(
        outcome(&r),
        json!({ "status": "blocked", "request_id": 1, "reason": "over_daily_cap" })
    );
    let r = w
        .spend(
            &wallet,
            spend_request("u1", "upkeep", w.treasury.id(), 2 * DOLLAR),
        )
        .await?;
    assert_eq!(outcome(&r)["status"], "blocked");
    assert!(w.wallet(&wallet).await?["pending"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(w.balance(w.treasury.id()).await?, 2 * DOLLAR);
    Ok(())
}

#[tokio::test]
async fn inference_paid_anywhere_but_the_treasury_is_blocked() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = agent_with(&w, rulebook()).await?;
    let r = w
        .spend(
            &wallet,
            spend_request("i1", "inference", w.scammer.id(), DOLLAR),
        )
        .await?;
    assert_eq!(outcome(&r)["reason"], "vendor_not_allowed");
    Ok(())
}

#[tokio::test]
async fn hiring_disabled_blocks_helper_payments() -> anyhow::Result<()> {
    let w = World::new().await?;
    let mut rb = rulebook();
    rb["may_hire"] = json!(false);
    let wallet = agent_with(&w, rb).await?;
    let helper = w.mint_agent(&w.bob).await?;
    let r = w
        .spend(&wallet, spend_request("h1", "helper", &helper, DOLLAR / 2))
        .await?;
    assert_eq!(outcome(&r)["reason"], "hiring_disabled");
    assert_eq!(w.balance(&helper).await?, 0);
    Ok(())
}

#[tokio::test]
async fn a_helper_payment_to_a_non_agent_account_is_blocked() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = agent_with(&w, rulebook()).await?;
    let r = w
        .spend(
            &wallet,
            spend_request("h1", "helper", w.bob.id(), DOLLAR / 2),
        )
        .await?;
    assert_eq!(outcome(&r)["reason"], "vendor_not_allowed");
    let r = w
        .spend(&wallet, spend_request("h2", "helper", &wallet, DOLLAR / 2))
        .await?;
    assert_eq!(outcome(&r)["reason"], "self_payment");
    assert_eq!(w.balance(w.bob.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn a_helper_payment_to_another_agent_within_budget_settles() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = agent_with(&w, rulebook()).await?;
    let helper = w.mint_agent(&w.bob).await?;
    let r = w
        .spend(&wallet, spend_request("h1", "helper", &helper, DOLLAR / 2))
        .await?;
    assert_eq!(outcome(&r)["status"], "settled");
    let r = w
        .spend(&wallet, spend_request("h2", "helper", &helper, DOLLAR + 1))
        .await?;
    assert_eq!(outcome(&r)["reason"], "over_helper_budget");
    assert_eq!(w.balance(&helper).await?, DOLLAR / 2);
    Ok(())
}

#[tokio::test]
async fn a_frozen_wallet_blocks_everything() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = agent_with(&w, allowlist(&w)).await?;
    ok(w.spend(
        &wallet,
        spend_request("big", "tool", w.vendor.id(), 3 * DOLLAR),
    )
    .await?)?;
    ok(w.owner_action(
        &w.alice,
        "set_frozen",
        json!({ "token_id": wallet, "frozen": true }),
        ONE_YOCTO,
    )
    .await?)?;
    for (key, kind, receiver) in [
        ("i", "inference", w.treasury.id()),
        ("u", "upkeep", w.treasury.id()),
        ("t", "tool", w.vendor.id()),
    ] {
        let r = w
            .spend(&wallet, spend_request(key, kind, receiver, 1))
            .await?;
        assert_eq!(outcome(&r)["reason"], "frozen", "{kind}");
    }
    let r = w
        .owner_action(
            &w.alice,
            "approve_spend",
            json!({ "token_id": wallet, "request_id": 0 }),
            ONE_YOCTO,
        )
        .await?;
    assert_eq!(outcome(&r)["reason"], "frozen");
    assert_eq!(w.balance(&wallet).await?, 50 * DOLLAR);
    // The owner can still take the money out of a frozen wallet.
    ok(w.owner_action(
        &w.alice,
        "withdraw",
        json!({ "token_id": wallet, "amount": DOLLAR.to_string() }),
        ONE_YOCTO,
    )
    .await?)?;
    assert_eq!(w.balance(w.alice.id()).await?, DOLLAR);
    Ok(())
}

#[tokio::test]
async fn a_repeated_request_key_returns_the_first_outcome_and_moves_money_once(
) -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = agent_with(&w, rulebook()).await?;
    let request = spend_request(
        "inference:job-7:stage-2",
        "inference",
        w.treasury.id(),
        DOLLAR,
    );
    let first = w.spend(&wallet, request.clone()).await?;
    let second = w.spend(&wallet, request).await?;
    assert_eq!(
        outcome(&first),
        json!({ "status": "settled", "request_id": 0 })
    );
    assert_eq!(outcome(&second), outcome(&first));
    assert!(!has_event(&second, "spend_settled"));
    assert_eq!(w.balance(w.treasury.id()).await?, DOLLAR);
    // The same key with different contents is still the same request.
    let blocked_first = w
        .spend(&wallet, spend_request("k2", "tool", w.scammer.id(), 1))
        .await?;
    let retried = w
        .spend(
            &wallet,
            spend_request("k2", "inference", w.treasury.id(), 1),
        )
        .await?;
    assert_eq!(outcome(&retried), outcome(&blocked_first));
    Ok(())
}

#[tokio::test]
async fn a_failed_transfer_releases_the_reservation() -> anyhow::Result<()> {
    let w = World::new().await?;
    // No credits in the wallet: the token transfer fails.
    let wallet = w.mint_agent(&w.alice).await?;
    let r = w
        .spend(
            &wallet,
            spend_request("i1", "inference", w.treasury.id(), DOLLAR),
        )
        .await?;
    assert_eq!(
        outcome(&r),
        json!({ "status": "failed", "request_id": 0, "reason": "transfer_failed" })
    );
    assert!(has_event(&r, "spend_failed"));
    assert_eq!(w.wallet(&wallet).await?["spent_today"], "0");
    Ok(())
}

#[tokio::test]
async fn the_daily_cap_resets_on_a_new_day() -> anyhow::Result<()> {
    const DAY_MS: u64 = 60_000;
    let w = World::with_day_ms(DAY_MS).await?;
    let mut rb = rulebook();
    rb["daily_cap"] = json!((3 * DOLLAR).to_string());
    let wallet = agent_with(&w, rb).await?;
    // Start well inside a day so the two same-day spends cannot straddle a boundary.
    let now_ms = w.worker.view_block().await?.timestamp() / 1_000_000;
    if DAY_MS - now_ms % DAY_MS < 20_000 {
        w.worker.fast_forward(100).await?;
    }
    let r = w
        .spend(
            &wallet,
            spend_request("d1", "inference", w.treasury.id(), 2 * DOLLAR),
        )
        .await?;
    assert_eq!(outcome(&r)["status"], "settled");
    let r = w
        .spend(
            &wallet,
            spend_request("d1b", "inference", w.treasury.id(), 2 * DOLLAR),
        )
        .await?;
    assert_eq!(outcome(&r)["reason"], "over_daily_cap");
    let day_before = w.wallet(&wallet).await?["day"].as_u64().unwrap();
    // The sandbox advances about 300 ms of block time per fast-forwarded block: 250 blocks pass the 60 s test day.
    w.worker.fast_forward(250).await?;
    assert_eq!(w.wallet(&wallet).await?["spent_today"], "0");
    let r = w
        .spend(
            &wallet,
            spend_request("d2", "inference", w.treasury.id(), 2 * DOLLAR),
        )
        .await?;
    assert_eq!(outcome(&r)["status"], "settled");
    let view = w.wallet(&wallet).await?;
    assert!(view["day"].as_u64().unwrap() > day_before);
    assert_eq!(view["spent_today"], (2 * DOLLAR).to_string());
    assert_eq!(view["day_ms"], DAY_MS);
    Ok(())
}

#[tokio::test]
async fn get_outcome_reports_the_latest_stage_after_approve_deny_and_rotation() -> anyhow::Result<()>
{
    let w = World::new().await?;
    let wallet = agent_with(&w, allowlist(&w)).await?;
    for key in ["a", "b", "c"] {
        ok(w.spend(
            &wallet,
            spend_request(key, "tool", w.vendor.id(), 3 * DOLLAR),
        )
        .await?)?;
    }
    // Approved after the owner removed the vendor: blocked, and the stored outcome says so.
    w.set_rulebook(&w.alice, &wallet, rulebook()).await?;
    ok(w.owner_action(
        &w.alice,
        "approve_spend",
        json!({ "token_id": wallet, "request_id": 0 }),
        ONE_YOCTO,
    )
    .await?)?;
    ok(w.owner_action(
        &w.alice,
        "deny_spend",
        json!({ "token_id": wallet, "request_id": 1 }),
        ONE_YOCTO,
    )
    .await?)?;
    w.transfer_nft(&w.alice, &wallet, &w.bob).await?;
    let get = |key: &'static str| w.view(&wallet, "get_outcome", json!({ "key": key }));
    assert_eq!(
        get("a").await?,
        json!({ "status": "blocked", "request_id": 0, "reason": "vendor_not_allowed" })
    );
    assert_eq!(
        get("b").await?,
        json!({ "status": "denied", "request_id": 1, "reason": "denied_by_owner" })
    );
    assert_eq!(
        get("c").await?,
        json!({ "status": "denied", "request_id": 2, "reason": "owner_changed" })
    );
    // One entry per key, never a stale duplicate.
    let recent = w.wallet(&wallet).await?["recent"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(recent.len(), 3);
    // Repeating an approved key returns its final outcome, not `pending`.
    let again = w
        .spend(
            &wallet,
            spend_request("a", "tool", w.vendor.id(), 3 * DOLLAR),
        )
        .await?;
    assert_eq!(outcome(&again)["status"], "blocked");
    Ok(())
}

#[tokio::test]
async fn a_contract_bond_goes_to_the_treasury_past_the_per_call_and_per_job_caps(
) -> anyhow::Result<()> {
    let w = World::new().await?;
    let mut rb = allowlist(&w);
    rb["max_per_job"] = json!((2 * DOLLAR).to_string());
    let wallet = agent_with(&w, rb).await?;
    // 3 dollars: over max_per_call (2) and max_per_job (2), within the daily cap (10).
    let r = w
        .spend(
            &wallet,
            with_job(
                spend_request("bond-1", "bond", w.treasury.id(), 3 * DOLLAR),
                "job-1",
            ),
        )
        .await?;
    assert_eq!(outcome(&r)["status"], "settled");
    assert_eq!(w.balance(w.treasury.id()).await?, 3 * DOLLAR);
    // The bond doesn't use up the job's tool budget.
    let r = w
        .spend(
            &wallet,
            with_job(
                spend_request("tool-1", "tool", w.vendor.id(), 2 * DOLLAR),
                "job-1",
            ),
        )
        .await?;
    assert_eq!(outcome(&r)["status"], "settled");
    Ok(())
}

#[tokio::test]
async fn a_bond_anywhere_but_the_treasury_is_blocked() -> anyhow::Result<()> {
    let w = World::new().await?;
    let wallet = agent_with(&w, rulebook()).await?;
    let r = w
        .spend(
            &wallet,
            spend_request("bond-1", "bond", w.scammer.id(), DOLLAR),
        )
        .await?;
    assert_eq!(outcome(&r)["reason"], "vendor_not_allowed");
    assert_eq!(w.balance(w.scammer.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn a_bond_over_the_daily_cap_is_blocked_not_queued() -> anyhow::Result<()> {
    let w = World::new().await?;
    let mut rb = rulebook();
    rb["daily_cap"] = json!((2 * DOLLAR).to_string());
    let wallet = agent_with(&w, rb).await?;
    let r = w
        .spend(
            &wallet,
            spend_request("bond-1", "bond", w.treasury.id(), 3 * DOLLAR),
        )
        .await?;
    assert_eq!(
        outcome(&r),
        json!({ "status": "blocked", "request_id": 0, "reason": "over_daily_cap" })
    );
    assert!(w.wallet(&wallet).await?["pending"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(w.balance(w.treasury.id()).await?, 0);
    Ok(())
}
