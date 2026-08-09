// The per-app declaration shape, as a game repo would ship it at
// tools/smoke.mjs. Everything is optional; an app that needs none of it ships
// no file at all, which is the case for every app in the fleet today.
export default {
    path: '/index.html',
    settleMs: 400,
    // Dismiss whatever stands between a cold load and a drawn frame. Runs
    // after load and before the settle wait, with the real Playwright page.
    async ready(page) {
        await page.click('#gate');
    },
};
