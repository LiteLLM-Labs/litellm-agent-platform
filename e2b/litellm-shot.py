#!/usr/bin/env python3
"""litellm-shot — screenshot a LiteLLM UI page with a FRUGAL chromium so it never
trips the sandbox memory threshold (default chromium + full-page render OOM-kills
a 4 GB sandbox). Logs in via the real form and saves a viewport PNG (not full_page).

Login is resilient: it tries several selector strategies (antd renders the form
with name/id "username"/"password", placeholders "Enter your ...", and a submit
button labelled "Login"). A missing selector is logged and skipped — it NEVER
aborts before the screenshot. We always write a PNG of whatever state we reached.

Usage:  litellm-shot <base_url> [page_query] [out_png]
  e.g.  litellm-shot http://127.0.0.1:4000 "?page=api-keys" /home/user/keys.png
"""
import os, sys

# The chromium baked into the template lives here. The harness's sandbox_execute
# does not inherit the image's ENV, so PLAYWRIGHT_BROWSERS_PATH is often unset at
# call time and playwright then can't find the browser ("Executable doesn't
# exist"). Default it ourselves so the helper is self-contained and the caller
# never has to remember to export it.
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/opt/ms-playwright")

from playwright.sync_api import sync_playwright

base = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:4000"
page_q = sys.argv[2] if len(sys.argv) > 2 else "?page=api-keys"
out = sys.argv[3] if len(sys.argv) > 3 else "/home/user/keys.png"
master = os.environ.get("LITELLM_MASTER_KEY", "sk-1234")

# Frugal flags keep chromium's RSS low — this is the whole point of the helper. KEEP THESE.
ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--single-process",
        "--disable-gpu", "--no-zygote", "--disable-extensions"]


def fill_first(pg, value, label):
    # Try locator strategies in priority order; first visible one wins. Never raises.
    locs = [
        pg.get_by_role("textbox", name=label),
        pg.get_by_label(label, exact=False),
        pg.get_by_placeholder(f"Enter your {label.lower()}"),
        pg.locator(f'input[name="{label.lower()}"]'),
        pg.locator(f'input#{label.lower()}'),
        pg.locator(f'input[autocomplete*="{label.lower()}"]'),
    ]
    for loc in locs:
        try:
            el = loc.first
            if el.is_visible(timeout=1500):
                el.fill(value, timeout=3000)
                return True
        except Exception:
            continue
    print(f"[litellm-shot] {label} field not found — skipping", file=sys.stderr)
    return False


with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    try:
        pg.goto(f"{base}/ui/", wait_until="domcontentloaded")
        pg.wait_for_timeout(10000)  # routes lazy-compile on first hit
        # Password field is the reliable login-form signal; absent => already logged in.
        try:
            has_form = pg.get_by_placeholder("Enter your password").first.is_visible(timeout=4000)
        except Exception:
            has_form = False
        if has_form:
            fill_first(pg, "admin", "Username")
            # antd Input.Password: label is "Password", placeholder "Enter your password".
            pw = fill_first(pg, master, "Password")
            for sel in ['button[type="submit"]', 'button:has-text("Login")',
                        'button:has-text("Sign")']:
                try:
                    btn = pg.locator(sel).first
                    if btn.is_visible(timeout=1500):
                        btn.click(timeout=3000)
                        break
                except Exception:
                    continue
            if not pw:
                print("[litellm-shot] password unfilled — submitting anyway", file=sys.stderr)
            pg.wait_for_timeout(8000)
        else:
            print("[litellm-shot] no login form (already logged in?) — continuing", file=sys.stderr)
        try:
            pg.wait_for_load_state("networkidle", timeout=15000)
        except Exception:
            pass
        try:
            pg.goto(f"{base}/ui/{page_q}", wait_until="domcontentloaded")
            pg.wait_for_timeout(10000)
        except Exception as e:
            print(f"[litellm-shot] keys-page nav failed: {e} — screenshotting current state", file=sys.stderr)
    finally:
        try:
            pg.screenshot(path=out)  # viewport only — NOT full_page (memory)
            print(out)
        except Exception as e:
            print(f"[litellm-shot] FATAL: could not write screenshot: {e}", file=sys.stderr)
            b.close()
            sys.exit(1)
        b.close()
