"""Live niches pipeline + referrals.

market_insights collection (upserted by keyword):
  { keyword, total_gigs, avg_orders_in_queue, score, is_gold,
    last_scanned, snapshot (compact), status, last_task_id }

scan_tasks collection:
  { task_id, user_id, keyword, status (running|complete|failed),
    started_at, completed_at, error }
"""
import os
import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import get_current_user
from scraper import deep_scrape
from billing import assert_can_scan

ADMIN_EMAIL = os.environ.get('ADMIN_EMAIL', '').lower().strip()

niches_router = APIRouter(prefix="/api")
referral_router = APIRouter(prefix="/api/referral")


class ScanIn(BaseModel):
    keyword: str = Field(min_length=2, max_length=120)


class RedeemIn(BaseModel):
    code: str = Field(min_length=4, max_length=40)


def compute_is_gold(total_gigs: int, avg_orders: float) -> bool:
    """GOLD: total_gigs < 500 AND avg_orders_in_queue > 8."""
    return (total_gigs is not None) and (total_gigs < 500) and (avg_orders > 8)


def compute_live_score(avg_orders: float, total_gigs: int) -> float:
    """LiveOpportunityScore = Orders / Competition (normalised 0-100)."""
    if not total_gigs or total_gigs <= 0:
        return 0.0
    raw = avg_orders / (total_gigs / 100.0)  # ratio
    return round(min(100.0, raw * 10), 1)


def make_live_routes(users_col, jobs_col, market_col, tasks_col, referral_col):
    async def latest_complete_job(keyword: str, user_id: str):
        return await jobs_col.find_one(
            {
                "user_id": user_id,
                "keyword": {"$regex": f"^{re.escape(keyword)}$", "$options": "i"},
                "status": "complete",
            },
            {"_id": 0},
            sort=[("created_at", -1)],
        )

    # --------- DEEP SCAN WORKER ---------
    async def run_deep_scan(task_id: str, keyword: str, user_id: str):
        """Async worker: deep_scrape → upsert market_insights → update task."""
        try:
            await tasks_col.update_one(
                {"task_id": task_id},
                {"$set": {"status": "running", "phase": "scraping"}},
            )
            result = await deep_scrape(keyword)
            total = result.get("total_services") or 0
            avg_orders = result.get("metrics", {}).get("avg_orders_in_queue", 0)
            score = compute_live_score(avg_orders, total)
            gold = compute_is_gold(total, avg_orders)

            snapshot = {
                "opportunity_score": result.get("opportunity_score"),
                "velocity_score": result.get("velocity_score"),
                "saturation_index": result.get("saturation_index"),
                "ratio_is_gold": result.get("ratio_is_gold"),
                "competition_to_order_ratio": result.get("competition_to_order_ratio"),
                "data_source": result.get("data_source"),
            }
            now = datetime.now(timezone.utc).isoformat()
            await market_col.update_one(
                {"keyword": keyword.lower()},
                {"$set": {
                    "keyword": keyword.lower(),
                    "display_keyword": keyword,
                    "total_gigs": total,
                    "avg_orders_in_queue": avg_orders,
                    "score": score,
                    "is_gold": gold,
                    "last_scanned": now,
                    "snapshot": snapshot,
                    "status": "complete",
                    "last_task_id": task_id,
                }, "$inc": {"scan_count": 1}},
                upsert=True,
            )
            await jobs_col.update_one(
                {"id": task_id, "user_id": user_id},
                {"$set": {"status": "complete", "completed_at": now, "result": result}},
            )
            await tasks_col.update_one(
                {"task_id": task_id},
                {"$set": {"status": "complete", "completed_at": now,
                          "score": score, "is_gold": gold, "phase": "done", "job_ready": True}},
            )
        except Exception as e:
            now = datetime.now(timezone.utc).isoformat()
            await jobs_col.update_one(
                {"id": task_id, "user_id": user_id},
                {"$set": {"status": "failed", "error": str(e)[:200], "completed_at": now}},
            )
            await tasks_col.update_one(
                {"task_id": task_id},
                {"$set": {"status": "failed", "error": str(e)[:200],
                          "completed_at": now, "job_ready": False}},
            )

    # --------- SCAN TRIGGER ---------
    @niches_router.post("/scan")
    async def trigger_scan(body: ScanIn, bg: BackgroundTasks, user=Depends(get_current_user)):
        user_doc = await users_col.find_one({"id": user["id"]}, {"_id": 0})
        if not user_doc:
            raise HTTPException(404, "User not found")
        await assert_can_scan(user_doc, jobs_col)

        keyword = body.keyword.strip()
        task_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        await tasks_col.insert_one({
            "task_id": task_id,
            "user_id": user["id"],
            "keyword": keyword,
            "status": "queued",
            "started_at": now,
        })
        # Eagerly upsert market_insights with "scanning" status so UI reflects activity instantly
        await market_col.update_one(
            {"keyword": keyword.lower()},
            {"$set": {"keyword": keyword.lower(), "display_keyword": keyword,
                      "status": "scanning", "last_task_id": task_id}},
            upsert=True,
        )
        # Mirror into fs_jobs so monthly quota counts this scan
        await jobs_col.insert_one({
            "id": task_id,
            "user_id": user["id"],
            "keyword": keyword,
            "status": "running",
            "created_at": now,
            "via": "live_pipeline",
            "result": None,
        })
        bg.add_task(run_deep_scan, task_id, keyword, user["id"])
        return {"task_id": task_id, "job_id": task_id, "status": "queued", "keyword": keyword}

    @niches_router.get("/scan/{task_id}")
    async def get_scan_task(task_id: str, user=Depends(get_current_user)):
        doc = await tasks_col.find_one({"task_id": task_id, "user_id": user["id"]}, {"_id": 0})
        if not doc:
            raise HTTPException(404, "Task not found")
        job = await jobs_col.find_one({"id": task_id, "user_id": user["id"]}, {"_id": 0})
        doc["job_id"] = task_id
        doc["job_status"] = job.get("status") if job else None
        doc["job_ready"] = bool(job and job.get("status") == "complete" and job.get("result"))
        if doc["job_ready"]:
            doc["result"] = job["result"]
        return doc

    # --------- LIVE NICHES BOARD ---------
    @niches_router.get("/niches")
    async def list_niches(limit: int = 30, only_gold: bool = False):
        q = {"is_gold": True} if only_gold else {}
        docs = await market_col.find(q, {"_id": 0}).sort([
            ("score", -1), ("last_scanned", -1),
        ]).limit(limit).to_list(limit)
        return {"count": len(docs), "items": docs}

    @niches_router.get("/niches/{keyword}")
    async def get_niche_detail(keyword: str, user=Depends(get_current_user)):
        market_doc = await market_col.find_one({"keyword": keyword.lower()}, {"_id": 0})
        user_job = await latest_complete_job(keyword, user["id"])
        if not market_doc and not user_job:
            raise HTTPException(404, "Niche not found")
        return {
            "keyword": keyword,
            "market_insight": market_doc,
            "latest_user_job": user_job,
            "detail_source": "user_job" if user_job else "market_snapshot",
            "can_rescan": True,
        }

    # --------- REFERRALS ---------
    def _generate_code(email: str) -> str:
        h = uuid.uuid5(uuid.NAMESPACE_DNS, email.lower()).hex[:8].upper()
        return f"FS-{h}"

    @referral_router.get("/code")
    async def my_code(user=Depends(get_current_user)):
        doc = await users_col.find_one({"id": user["id"]}, {"_id": 0})
        if not doc:
            raise HTTPException(404, "User not found")
        code = doc.get("referral_code") or _generate_code(doc["email"])
        if doc.get("referral_code") != code:
            await users_col.update_one({"id": user["id"]}, {"$set": {"referral_code": code}})
        # Stats
        redemptions = await referral_col.count_documents({"referrer_id": user["id"]})
        return {
            "code": code,
            "share_url": f"/?ref={code}",
            "redemptions": redemptions,
            "reward": "1 month of Pro for each friend who upgrades, +1 month for you",
        }

    @referral_router.post("/redeem")
    async def redeem(body: RedeemIn, user=Depends(get_current_user)):
        code = body.code.strip().upper()
        # Don't allow self-redeem
        my = await users_col.find_one({"id": user["id"]}, {"_id": 0})
        if not my:
            raise HTTPException(404, "User not found")
        if my.get("referral_code") == code:
            raise HTTPException(400, "Cannot redeem your own code")
        if my.get("referral_redeemed"):
            raise HTTPException(400, "You have already redeemed a referral")
        referrer = await users_col.find_one({"referral_code": code}, {"_id": 0})
        if not referrer:
            raise HTTPException(404, "Invalid referral code")

        now = datetime.now(timezone.utc)
        grant_days = 30

        # Grant 30d pro to the redeemer
        cur_exp = my.get("plan_expires_at")
        try:
            base = datetime.fromisoformat(cur_exp) if cur_exp else now
        except Exception:
            base = now
        if base < now:
            base = now
        new_exp = (base + timedelta(days=grant_days)).isoformat()
        await users_col.update_one(
            {"id": user["id"]},
            {"$set": {"plan": "pro", "plan_expires_at": new_exp, "referral_redeemed": code}},
        )

        # Grant 30d pro to referrer (stack on top of existing expiry)
        ref_exp = referrer.get("plan_expires_at")
        try:
            r_base = datetime.fromisoformat(ref_exp) if ref_exp else now
        except Exception:
            r_base = now
        if r_base < now:
            r_base = now
        r_new_exp = (r_base + timedelta(days=grant_days)).isoformat()
        # Admin doesn't need a date (always pro), but we still update for fairness
        await users_col.update_one(
            {"id": referrer["id"]},
            {"$set": {"plan": "pro", "plan_expires_at": r_new_exp}},
        )

        await referral_col.insert_one({
            "id": str(uuid.uuid4()),
            "code": code,
            "referrer_id": referrer["id"],
            "referrer_email": referrer["email"],
            "redeemer_id": user["id"],
            "redeemer_email": user["email"],
            "granted_days": grant_days,
            "redeemed_at": now.isoformat(),
        })
        return {"granted_days": grant_days, "new_plan_expires_at": new_exp}

    return niches_router, referral_router
