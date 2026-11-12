//! Job escrow: the budget is held until the job settles; payouts go to the agent wallet.

use hustle_integration_tests::*;
use serde_json::json;

async fn funded() -> anyhow::Result<(World, near_workspaces::AccountId)> {
    let w = World::new().await?;
    let wallet = w.mint_agent(&w.alice).await?;
    w.mint_credits(w.client.id(), 10 * DOLLAR).await?;
    Ok((w, wallet))
}

#[tokio::test]
async fn accepting_pays_price_minus_fee_to_the_wallet_and_the_fee_rounded_down_to_the_treasury(
) -> anyhow::Result<()> {
    let (w, wallet) = funded().await?;
    let price: u128 = 1_000_001;
    ok(w.post_job(&w.client, "job-a", 3 * DOLLAR, false, 60_000)
        .await?)?;
    assert_eq!(w.balance(w.client.id()).await?, 7 * DOLLAR);
    assert_eq!(w.balance(w.jobs.id()).await?, 3 * DOLLAR);
    ok(w.jobs_call(
        &w.client,
        "award",
        json!({ "job_id": 0, "agent_id": wallet, "price": price.to_string() }),
    )
    .await?)?;
    // The unused budget comes back at once.
    assert_eq!(w.balance(w.client.id()).await?, 10 * DOLLAR - price);
    ok(w.jobs_call(
        &w.operator,
        "deliver",
        json!({ "job_id": 0, "agent_id": wallet, "work_hash": "sha256:w" }),
    )
    .await?)?;
    let r = w
        .jobs_call(&w.client, "accept", json!({ "job_id": 0, "rating": 5 }))
        .await?;
    ok(r.clone())?;
    assert!(has_event(&r, "job_settled"));
    // 1_000_001 * 5% = 50_000.05, rounded down.
    assert_eq!(w.balance(w.treasury.id()).await?, 50_000);
    assert_eq!(w.balance(&wallet).await?, 950_001);
    assert_eq!(w.balance(w.alice.id()).await?, 0);
    assert_eq!(w.balance(w.jobs.id()).await?, 0);
    assert!(w.job(0).await?.is_null());
    let rep = w
        .view(w.rep.id(), "get_reputation", json!({ "agent_id": wallet }))
        .await?;
    assert_eq!(rep["jobs_completed"], 1);
    assert_eq!(rep["rating_sum"], 5);
    assert_eq!(rep["recent"][0]["outcome"], "completed");
    Ok(())
}

#[tokio::test]
async fn a_dispute_resolved_as_a_refund_returns_the_price_to_the_client() -> anyhow::Result<()> {
    let (w, wallet) = funded().await?;
    let job = w
        .delivered_job("job-a", &wallet, 2 * DOLLAR, 2 * DOLLAR, 60_000)
        .await?;
    ok(w.jobs_call(&w.client, "dispute", json!({ "job_id": job }))
        .await?)?;
    assert_eq!(w.job(job).await?["status"], "disputed");
    ok(w.jobs_call(
        &w.operator,
        "resolve",
        json!({ "job_id": job, "refund": true }),
    )
    .await?)?;
    assert_eq!(w.balance(w.client.id()).await?, 10 * DOLLAR);
    assert_eq!(w.balance(&wallet).await?, 0);
    assert!(w.job(job).await?.is_null());
    let rep = w
        .view(w.rep.id(), "get_reputation", json!({ "agent_id": wallet }))
        .await?;
    assert_eq!(rep["disputes_lost"], 1);
    assert_eq!(rep["jobs_completed"], 0);
    Ok(())
}

#[tokio::test]
async fn a_dispute_resolved_for_the_agent_pays_the_wallet() -> anyhow::Result<()> {
    let (w, wallet) = funded().await?;
    let job = w
        .delivered_job("job-a", &wallet, 2 * DOLLAR, 2 * DOLLAR, 60_000)
        .await?;
    ok(w.jobs_call(&w.client, "dispute", json!({ "job_id": job }))
        .await?)?;
    ok(w.jobs_call(
        &w.operator,
        "resolve",
        json!({ "job_id": job, "refund": false }),
    )
    .await?)?;
    assert_eq!(w.balance(&wallet).await?, 1_900_000);
    let rep = w
        .view(w.rep.id(), "get_reputation", json!({ "agent_id": wallet }))
        .await?;
    assert_eq!(rep["recent"][0]["outcome"], "dispute_won");
    Ok(())
}

#[tokio::test]
async fn cancelling_before_award_refunds_the_budget() -> anyhow::Result<()> {
    let (w, wallet) = funded().await?;
    ok(w.post_job(&w.client, "job-a", 3 * DOLLAR, false, 60_000)
        .await?)?;
    ok(w.jobs_call(&w.client, "cancel", json!({ "job_id": 0 }))
        .await?)?;
    assert_eq!(w.balance(w.client.id()).await?, 10 * DOLLAR);
    assert!(w.job(0).await?.is_null());
    ok(w.post_job(&w.client, "job-b", 3 * DOLLAR, false, 60_000)
        .await?)?;
    ok(w.jobs_call(
        &w.client,
        "award",
        json!({ "job_id": 1, "agent_id": wallet, "price": "1000000" }),
    )
    .await?)?;
    let r = w
        .jobs_call(&w.client, "cancel", json!({ "job_id": 1 }))
        .await?;
    assert_failed_with(&r, "wrong_status");
    Ok(())
}

#[tokio::test]
async fn anyone_can_release_a_delivered_job_after_the_review_window() -> anyhow::Result<()> {
    let (w, wallet) = funded().await?;
    let job = w
        .delivered_job("job-a", &wallet, 2 * DOLLAR, 2 * DOLLAR, 3_000)
        .await?;
    let r = w
        .jobs_call(&w.stranger, "release_expired", json!({ "job_id": job }))
        .await?;
    assert_failed_with(&r, "review_window_open");
    w.worker.fast_forward(30).await?;
    let r = w
        .jobs_call(&w.client, "dispute", json!({ "job_id": job }))
        .await?;
    assert_failed_with(&r, "review_window_closed");
    ok(
        w.jobs_call(&w.stranger, "release_expired", json!({ "job_id": job }))
            .await?,
    )?;
    assert_eq!(w.balance(&wallet).await?, 1_900_000);
    let rep = w
        .view(w.rep.id(), "get_reputation", json!({ "agent_id": wallet }))
        .await?;
    assert_eq!(rep["rating_sum"], 4);
    Ok(())
}

#[tokio::test]
async fn a_dust_budget_is_refunded() -> anyhow::Result<()> {
    let (w, _) = funded().await?;
    let r = w.post_job(&w.client, "dust", 99_999, false, 0).await?;
    ok(r.clone())?;
    let refunded = events(&r)
        .into_iter()
        .find(|e| e["event"] == "post_refunded")
        .expect("event");
    assert_eq!(refunded["data"]["reason"], "below_min_budget");
    assert_eq!(w.balance(w.client.id()).await?, 10 * DOLLAR);
    assert!(w.job_by_key("dust").await?.is_null());
    Ok(())
}

#[tokio::test]
async fn a_duplicate_job_key_is_refunded_even_after_the_first_job_settles() -> anyhow::Result<()> {
    let (w, _) = funded().await?;
    ok(w.post_job(&w.client, "job-a", 2 * DOLLAR, false, 0).await?)?;
    let r = w.post_job(&w.client, "job-a", 2 * DOLLAR, false, 0).await?;
    assert!(has_event(&r, "post_refunded"));
    assert_eq!(w.balance(w.client.id()).await?, 8 * DOLLAR);
    ok(w.jobs_call(&w.client, "cancel", json!({ "job_id": 0 }))
        .await?)?;
    let r = w.post_job(&w.client, "job-a", 2 * DOLLAR, false, 0).await?;
    assert!(has_event(&r, "post_refunded"));
    assert_eq!(w.balance(w.client.id()).await?, 10 * DOLLAR);
    assert!(w
        .view(
            w.jobs.id(),
            "is_job_key_used",
            json!({ "job_key": "job-a" })
        )
        .await?
        .as_bool()
        .unwrap());
    Ok(())
}

#[tokio::test]
async fn a_malformed_post_is_refunded() -> anyhow::Result<()> {
    let (w, _) = funded().await?;
    let r = w
        .client
        .call(w.credits.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": w.jobs.id(), "amount": DOLLAR.to_string(), "msg": "{\"steal\":1}" }))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    ok(r)?;
    assert_eq!(w.balance(w.client.id()).await?, 10 * DOLLAR);
    Ok(())
}

#[tokio::test]
async fn the_operator_can_award_only_auto_award_jobs() -> anyhow::Result<()> {
    let (w, wallet) = funded().await?;
    ok(w.post_job(&w.client, "auto", 2 * DOLLAR, true, 0).await?)?;
    let r = w
        .jobs_call(
            &w.operator,
            "award",
            json!({ "job_id": 0, "agent_id": w.bob.id(), "price": "1000000" }),
        )
        .await?;
    assert_failed_with(&r, "not_agent");
    let r = w
        .jobs_call(
            &w.operator,
            "award",
            json!({ "job_id": 0, "agent_id": wallet, "price": (3 * DOLLAR).to_string() }),
        )
        .await?;
    assert_failed_with(&r, "invalid_price");
    ok(w.jobs_call(
        &w.operator,
        "award",
        json!({ "job_id": 0, "agent_id": wallet, "price": "1000000" }),
    )
    .await?)?;
    assert_eq!(w.job(0).await?["status"], "awarded");
    Ok(())
}

/// The payout receiver is an agent-shaped id that was never registered on credits, so the payout
/// transfer really fails; after registration, `retry_payout` delivers it.
#[tokio::test]
async fn a_failed_payout_is_kept_and_can_be_retried() -> anyhow::Result<()> {
    let (w, _) = funded().await?;
    let ghost: near_workspaces::AccountId = format!("agent-99.{}", w.registry.id()).parse()?;
    let job = w
        .delivered_job("job-a", &ghost, 2 * DOLLAR, 2 * DOLLAR, 60_000)
        .await?;
    let r = w
        .jobs_call(&w.client, "accept", json!({ "job_id": job, "rating": 5 }))
        .await?;
    assert!(has_event(&r, "payout_failed"));
    let stored = w.job(job).await?;
    assert_eq!(stored["status"], "payout_failed");
    assert_eq!(
        stored["owed"],
        json!([{ "receiver_id": ghost, "amount": "1900000", "purpose": "agent_payout" }])
    );
    assert_eq!(stored["escrow"], "1900000");
    // The fee went through; the agent's share is still held.
    assert_eq!(w.balance(w.treasury.id()).await?, 100_000);
    assert_eq!(w.balance(w.jobs.id()).await?, 1_900_000);

    // Retrying before the cause is fixed fails again and keeps the debt.
    let r = w
        .jobs_call(&w.stranger, "retry_payout", json!({ "job_id": job }))
        .await?;
    assert!(r.is_success() && has_event(&r, "payout_failed"));
    assert_eq!(w.job(job).await?["status"], "payout_failed");

    w.register(&ghost).await?;
    ok(
        w.jobs_call(&w.stranger, "retry_payout", json!({ "job_id": job }))
            .await?,
    )?;
    assert_eq!(w.balance(&ghost).await?, 1_900_000);
    assert!(w.job(job).await?.is_null());
    let r = w
        .jobs_call(&w.stranger, "retry_payout", json!({ "job_id": job }))
        .await?;
    assert_failed_with(&r, "not_found");
    Ok(())
}

fn post_msg(job_key: &str, delivery_window_ms: u64) -> serde_json::Value {
    json!({ "post": {
        "job_key": job_key, "spec_hash": "sha256:spec", "auto_award": false,
        "review_window_ms": 60_000, "delivery_window_ms": delivery_window_ms,
    }})
}

#[tokio::test]
async fn an_awarded_job_never_delivered_is_refunded_to_the_client_after_the_deadline(
) -> anyhow::Result<()> {
    let (w, wallet) = funded().await?;
    ok(
        w.post_job_msg(&w.client, 2 * DOLLAR, post_msg("job-a", 60_000))
            .await?,
    )?;
    let job = w.job(0).await?;
    assert_eq!(job["delivery_window_ms"], 60_000);
    ok(w.jobs_call(
        &w.client,
        "award",
        json!({ "job_id": 0, "agent_id": wallet, "price": DOLLAR.to_string() }),
    )
    .await?)?;
    let r = w
        .jobs_call(&w.stranger, "reclaim_undelivered", json!({ "job_id": 0 }))
        .await?;
    assert_failed_with(&r, "delivery_window_open");
    // About 300 ms of block time per fast-forwarded block: 250 blocks pass the one-minute deadline.
    w.worker.fast_forward(250).await?;
    // Anyone may trigger it; the money always goes to the client.
    let r = w
        .jobs_call(&w.stranger, "reclaim_undelivered", json!({ "job_id": 0 }))
        .await?;
    ok(r.clone())?;
    let settled = events(&r)
        .into_iter()
        .find(|e| e["event"] == "job_settled")
        .expect("settled");
    assert_eq!(settled["data"]["settlement"], "reclaimed");
    assert_eq!(w.balance(w.client.id()).await?, 10 * DOLLAR);
    assert_eq!(w.balance(w.stranger.id()).await?, 0);
    assert!(w.job(0).await?.is_null());
    // Nothing recorded against the agent, and a late delivery has nothing to deliver to.
    assert!(w
        .view(w.rep.id(), "get_reputation", json!({ "agent_id": wallet }))
        .await?
        .is_null());
    let r = w
        .jobs_call(
            &w.operator,
            "deliver",
            json!({ "job_id": 0, "agent_id": wallet, "work_hash": "h" }),
        )
        .await?;
    assert_failed_with(&r, "not_found");
    Ok(())
}

#[tokio::test]
async fn a_delivered_job_cannot_be_reclaimed_as_undelivered() -> anyhow::Result<()> {
    let (w, wallet) = funded().await?;
    ok(
        w.post_job_msg(&w.client, 2 * DOLLAR, post_msg("job-a", 60_000))
            .await?,
    )?;
    ok(w.jobs_call(
        &w.client,
        "award",
        json!({ "job_id": 0, "agent_id": wallet, "price": DOLLAR.to_string() }),
    )
    .await?)?;
    ok(w.jobs_call(
        &w.operator,
        "deliver",
        json!({ "job_id": 0, "agent_id": wallet, "work_hash": "h" }),
    )
    .await?)?;
    w.worker.fast_forward(250).await?;
    let r = w
        .jobs_call(&w.client, "reclaim_undelivered", json!({ "job_id": 0 }))
        .await?;
    assert_failed_with(&r, "wrong_status");
    Ok(())
}

#[tokio::test]
async fn a_delivery_window_outside_the_bounds_is_refunded() -> anyhow::Result<()> {
    let (w, _) = funded().await?;
    for window in [59_999u64, 7 * 86_400_000 + 1] {
        let r = w
            .post_job_msg(&w.client, 2 * DOLLAR, post_msg("job-a", window))
            .await?;
        let refunded = events(&r)
            .into_iter()
            .find(|e| e["event"] == "post_refunded")
            .expect("event");
        assert_eq!(refunded["data"]["reason"], "invalid_delivery_window");
    }
    assert_eq!(w.balance(w.client.id()).await?, 10 * DOLLAR);
    // Omitting it gives one day.
    ok(w.post_job(&w.client, "job-b", 2 * DOLLAR, false, 0).await?)?;
    assert_eq!(w.job(0).await?["delivery_window_ms"], 86_400_000);
    Ok(())
}

/// An award to an agent-shaped account that does not exist: the payout can never land, so after a
/// delivery window the client gets it back. The fee already went to the treasury.
#[tokio::test]
async fn a_payout_that_keeps_failing_goes_back_to_the_client_after_the_deadline(
) -> anyhow::Result<()> {
    let (w, _) = funded().await?;
    let ghost: near_workspaces::AccountId = format!("agent-99.{}", w.registry.id()).parse()?;
    ok(
        w.post_job_msg(&w.client, 2 * DOLLAR, post_msg("job-a", 60_000))
            .await?,
    )?;
    ok(w.jobs_call(
        &w.client,
        "award",
        json!({ "job_id": 0, "agent_id": ghost, "price": (2 * DOLLAR).to_string() }),
    )
    .await?)?;
    ok(w.jobs_call(
        &w.operator,
        "deliver",
        json!({ "job_id": 0, "agent_id": ghost, "work_hash": "h" }),
    )
    .await?)?;
    let r = w
        .jobs_call(&w.client, "accept", json!({ "job_id": 0, "rating": 5 }))
        .await?;
    assert!(has_event(&r, "payout_failed"));
    assert_eq!(w.job(0).await?["status"], "payout_failed");
    let r = w
        .jobs_call(&w.stranger, "reclaim_failed_payout", json!({ "job_id": 0 }))
        .await?;
    assert_failed_with(&r, "payout_window_open");
    w.worker.fast_forward(250).await?;
    ok(
        w.jobs_call(&w.stranger, "reclaim_failed_payout", json!({ "job_id": 0 }))
            .await?,
    )?;
    assert_eq!(w.balance(w.client.id()).await?, 10 * DOLLAR - 100_000);
    assert_eq!(w.balance(w.treasury.id()).await?, 100_000);
    assert_eq!(w.balance(w.jobs.id()).await?, 0);
    assert!(w.job(0).await?.is_null());
    Ok(())
}
