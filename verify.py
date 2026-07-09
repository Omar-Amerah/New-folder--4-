from playwright.sync_api import sync_playwright

def run_cuj(page):
    page.goto("http://localhost:5544")
    page.wait_for_timeout(1000)

    # Click "Create" to start a private room
    page.get_by_role("button", name="Create").click()
    page.wait_for_timeout(1000)

    # Click "Start ship design" in lobby
    page.get_by_role("button", name="Start ship design").click()
    page.wait_for_timeout(1000)

    # Open Ship Designer
    page.get_by_role("button", name="Open Ship Designer").click()
    page.wait_for_timeout(1000)

    # Click Power tab
    page.get_by_role("button", name="Power").click()
    page.wait_for_timeout(500)

    # Select Reactor (now 2x1) in the part list
    page.locator(".part-category-list").get_by_role("button", name="Reactor").click()
    page.wait_for_timeout(500)

    grid = page.locator(".build-grid")
    box = grid.bounding_box()
    if box:
        cell_size = box["width"] / 15

        # Core is at 7,7 (0-based) so center is at x=7*size, y=7*size.
        # Let's hover at x=8, y=7 (just right of core).
        hover_x = box["x"] + (8.5 * cell_size)
        hover_y = box["y"] + (7.5 * cell_size)

        page.mouse.move(hover_x, hover_y)
        page.wait_for_timeout(500)

        # Rotate using R
        page.keyboard.press("r")
        page.wait_for_timeout(500)

        # Click to place
        page.mouse.click(hover_x, hover_y)
        page.wait_for_timeout(500)

        # Hover weapons
        page.get_by_role("button", name="Weapons").click()
        page.wait_for_timeout(500)

        page.locator(".part-category-list").get_by_role("button", name="Railgun").click()
        page.wait_for_timeout(500)

        # Hover over x=8, y=6
        hover_x = box["x"] + (8.5 * cell_size)
        hover_y = box["y"] + (6.5 * cell_size)
        page.mouse.move(hover_x, hover_y)
        page.wait_for_timeout(500)

    # Take screenshot at the key moment
    page.screenshot(path="/home/jules/verification/screenshots/verification.png")
    page.wait_for_timeout(1000)

if __name__ == "__main__":
    import os
    os.makedirs("/home/jules/verification/videos", exist_ok=True)
    os.makedirs("/home/jules/verification/screenshots", exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            record_video_dir="/home/jules/verification/videos",
            viewport={"width": 1280, "height": 720}
        )
        page = context.new_page()
        try:
            run_cuj(page)
        finally:
            context.close()
            browser.close()
