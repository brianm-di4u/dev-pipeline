// Starter test for the shared/test-harness runner. It runs at desktop and mobile
// sizes. Replace it as the project grows, and name acceptance criteria in test
// names, such as "AC-1: ...".
export const tests = [
  {
    name: 'starts, responds to a tap, and fits the screen',
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
