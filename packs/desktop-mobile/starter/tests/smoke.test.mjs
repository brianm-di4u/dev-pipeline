// Tests the web front end in a browser at desktop and mobile sizes. Rust's own tests
// are in src-tauri/src/lib.rs, and `verify` also builds the real desktop app.
export const tests = [
  {
    name: 'the front end starts, responds to a tap, and fits the screen',
    url: 'web/index.html',
    async run(t) {
      await t.game('newGame');
      await t.shot('01-start');

      const before = await t.state();
      const box = await t.page.locator('#stage').boundingBox();
      await t.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await t.waitFrames();
      await t.page.waitForFunction((expected) => window.__game.getState().score === expected, before.score + 1);
      const after = await t.state();

      t.equal(after.score, before.score + 1, 'a tap scores a point');
      await t.shot('02-after-tap');
      await t.checkLayout();
    },
  },
];
