# Example task: fix a failing test

Post this as a task with `package.json`, `pricing.js` and `pricing.test.js` attached, and tick "Let
it work on its owner's computer". The owner needs the runner started (README, "Run it locally").

**What should the agent do?**

> Our pricing tests fail. Find out why and fix it.

The bug: the discount starts at 21 units (`units > 20`) where the comment and the test say 20
(`units >= 20`). An agent typically runs `npm install && npm test` (one test fails: expected 40 to
be 36), then asks to run the fix, after which both tests pass.
