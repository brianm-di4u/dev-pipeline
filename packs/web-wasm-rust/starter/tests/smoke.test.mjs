// Runs against the built app in dist/, so it tests the real WASM. Build it first with
// trunk, which `verify` does for you.
export const tests = [
  {
    name: 'the built app starts, responds to a tap through WASM, and fits the screen',
    url: 'dist/index.html',
    async run(t) {
      await t.game('newGame');
      await t.shot('01-start');

      const before = await t.state();
      const box = await t.page.locator('#stage').boundingBox();
      await t.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await t.waitFrames();
      const after = await t.state();

      t.equal(after.score, before.score + 1, 'a tap scores a point');
      await t.shot('02-after-tap');
      await t.checkLayout();
    },
  },
];
