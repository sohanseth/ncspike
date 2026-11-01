"""Live authenticated regression: python3 tests/prompt-e/turn_off_confirmation.e2e.py.

Uses the managed preview session, never mocks settings or saves credentials.
Temporarily enables voice replies (no stored data or provider calls), then restores
its initial value in finally. Consent audit entries intentionally remain.
Requires the sandbox's preinstalled Python Playwright and requests packages.
"""
import asyncio
import json
import os
from pathlib import Path
import unittest

import requests
from playwright.async_api import async_playwright, expect


ROOT = Path(__file__).resolve().parents[2]
ORIGIN = "http://localhost:8080"
FEATURE_TITLE = "Spoken replies by ElevenLabs"
SCREENSHOTS = Path("/tmp/browser/turn-off-confirmation/screenshots")


def managed_session():
    if os.environ.get("LOVABLE_BROWSER_AUTH_STATUS") == "injected":
        return (
            os.environ["LOVABLE_BROWSER_SUPABASE_STORAGE_KEY"],
            json.loads(os.environ["LOVABLE_BROWSER_SUPABASE_SESSION_JSON"]),
            json.loads(os.environ.get("LOVABLE_BROWSER_SUPABASE_COOKIES_JSON") or "[]"),
        )
    path = Path.home() / ".cache/lovable-auth/session.json"
    if not path.exists():
        raise RuntimeError("Mint a managed preview session with lovable auth-session --json first.")
    minted = json.loads(path.read_text())
    return minted["storage_key"], minted["session"], minted.get("cookies") or []


def database_snapshot(session):
    # Read only public backend configuration; do not output keys or session data.
    config = {}
    for line in (ROOT / ".env").read_text().splitlines():
        name, sep, value = line.partition("=")
        if sep and name.startswith("VITE_SUPABASE_"):
            config[name] = value.strip().strip('"').strip("'")
    headers = {
        "apikey": config["VITE_SUPABASE_PUBLISHABLE_KEY"],
        "Authorization": "Bearer " + session["access_token"],
    }
    snapshot = {}
    for table in ("cloud_consents", "user_settings"):
        response = requests.get(
            config["VITE_SUPABASE_URL"] + "/rest/v1/" + table,
            headers=headers,
            params={"select": "*", "user_id": "eq." + session["user"]["id"], **(
                {"order": "id.asc"} if table == "cloud_consents" else {}
            )},
            timeout=20,
        )
        if response.status_code != 200:
            raise RuntimeError(f"Cannot verify persisted {table}: HTTP {response.status_code}")
        snapshot[table] = response.json()
    return snapshot


class TurnOffConfirmationE2E(unittest.IsolatedAsyncioTestCase):
    async def test_confirmation_cancel_and_explicit_turn_off(self):
        key, session, cookies = managed_session()
        SCREENSHOTS.mkdir(parents=True, exist_ok=True)
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            context = await browser.new_context(viewport={"width": 1280, "height": 1800})
            page = await context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(type(error).__name__))
            if cookies:
                await context.add_cookies([{**cookie, "url": ORIGIN} for cookie in cookies])
            await page.goto(ORIGIN)
            await page.evaluate("([k,v]) => localStorage.setItem(k,v)", [key, json.dumps(session)])

            async def open_settings():
                await page.goto(ORIGIN + "/workspace/privacy")
                await expect(page.get_by_role("heading", name="Cloud features", exact=True)).to_be_visible()
                # Every feature's controlled switch must finish its authenticated read.
                await expect(page.get_by_role("switch", name=FEATURE_TITLE, exact=True)).to_be_visible()
                # SSR renders off switches before hydration attaches click handlers.
                await page.wait_for_load_state("networkidle")

            async def turn_on():
                await switch.click()
                dialog = page.get_by_role("dialog").filter(
                    has=page.get_by_role("heading", name=FEATURE_TITLE, exact=True)
                )
                await expect(dialog).to_be_visible()
                await dialog.get_by_role("button", name="Turn on", exact=True).click()
                await expect(dialog).not_to_be_visible()
                await expect(switch).to_be_checked()

            await open_settings()
            switch = page.get_by_role("switch", name=FEATURE_TITLE, exact=True)
            # Await actual feature-state response via persisted baseline + UI agreement,
            # rather than interpreting the initial empty render as an off setting.
            initial = await asyncio.to_thread(database_snapshot, session)
            consents = [c for c in initial["cloud_consents"] if c["feature"] == "voice_replies"]
            latest = consents[-1] if consents else None
            feature_source = (ROOT / "src/lib/cloud-features.ts").read_text()
            voice_definition = feature_source.split("  voice_replies: {", 1)[1].split("  web_search: {", 1)[0]
            import re
            version = re.search(r'version: "([^"]+)"', voice_definition).group(1)
            original_on = bool(latest and latest["granted"] and latest["wording_version"] == version)
            await expect(switch).to_have_attribute("aria-checked", str(original_on).lower())
            try:
                if not original_on:
                    await turn_on()
                baseline = await asyncio.to_thread(database_snapshot, session)
                await switch.click()
                row = page.get_by_role("listitem").filter(has=switch)
                confirmation = row.get_by_role("button", name="Turn off", exact=True)
                await expect(confirmation).to_be_visible()
                await expect(switch).to_be_checked()
                await row.screenshot(path=str(SCREENSHOTS / "1_confirmation.png"))
                self.assertTrue(baseline == await asyncio.to_thread(database_snapshot, session),
                                "Opening confirmation must not write settings or consent")

                await row.get_by_role("button", name="Keep on", exact=True).click()
                await expect(confirmation).not_to_be_visible()
                await expect(switch).to_be_checked()
                self.assertTrue(baseline == await asyncio.to_thread(database_snapshot, session),
                                "Cancel must leave all account settings and consent rows unchanged")
                await open_settings()
                await expect(switch).to_be_checked()
                await expect(confirmation).not_to_be_visible()
                self.assertTrue(baseline == await asyncio.to_thread(database_snapshot, session),
                                "Canceled change must remain unchanged after reload")
                await row.screenshot(path=str(SCREENSHOTS / "2_canceled_reloaded.png"))

                # Positive control: only the explicit Turn off action may persist a revoke.
                await switch.click()
                await expect(confirmation).to_be_visible()
                await expect(switch).to_be_checked()
                await confirmation.click()
                await expect(confirmation).not_to_be_visible()
                await expect(switch).not_to_be_checked()
                after = await asyncio.to_thread(database_snapshot, session)
                added = [c for c in after["cloud_consents"] if c["id"] not in {
                    c["id"] for c in baseline["cloud_consents"]
                }]
                self.assertEqual(len(added), 1)
                self.assertEqual(added[0]["feature"], "voice_replies")
                self.assertIs(added[0]["granted"], False)
                self.assertTrue(after["user_settings"] == baseline["user_settings"])
                await open_settings()
                await expect(switch).not_to_be_checked()
                await row.screenshot(path=str(SCREENSHOTS / "3_explicitly_off.png"))
                self.assertEqual(errors, [], "No browser runtime errors expected")
            finally:
                # Restore only through the real consent UI, including on failure.
                await open_settings()
                current = await asyncio.to_thread(database_snapshot, session)
                voice = [c for c in current["cloud_consents"] if c["feature"] == "voice_replies"]
                last = voice[-1] if voice else None
                current_on = bool(last and last["granted"] and last["wording_version"] == version)
                await expect(switch).to_have_attribute("aria-checked", str(current_on).lower())
                if original_on and not current_on:
                    await turn_on()
                elif not original_on and current_on:
                    await switch.click()
                    await page.get_by_role("button", name="Turn off", exact=True).click()
                    await expect(switch).not_to_be_checked()
                await browser.close()


if __name__ == "__main__":
    unittest.main()