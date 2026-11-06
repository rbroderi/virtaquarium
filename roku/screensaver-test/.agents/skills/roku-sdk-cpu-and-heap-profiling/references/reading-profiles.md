<!-- @roku-sdk/ai managed v=1 hash=57c642765d3cce932ec25db7f3916ac407bc8c90dd94b25907ef81f2966d8ea2 skills=1 do-not-edit -->

# Reading a profile file

The tools write Chrome DevTools formats verbatim, so each file also opens in Chrome DevTools
(Performance for `.cpuprofile`, Memory for `.heapprofile` and `.heapsnapshot`). An agent reads
them as JSON.

## CPU: `.cpuprofile`

`nodes[]` is a call tree: each node has `id`, `callFrame` (`functionName`, `url`, `lineNumber`,
`columnNumber`) and `children` (ids). `samples[]` is the node id hit at each sample and
`timeDeltas[]` the microseconds since the previous one.

- **Self time** is the sum of `timeDeltas` for samples landing on a node. Rank on it to find
  what burns the time itself.
- **Total time** is self plus all descendants. A framework wrapper has large total and tiny
  self; reading it as the culprit is the usual wrong answer. Descend to the child with the
  self time.
- Line and column refer to the generated bundle. Take `functionName`, then find it with
  `cdp_source_grep`.

```js
// node top-self.js file.cpuprofile
const p = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const self = new Map();
p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)));
const byId = new Map(p.nodes.map(n => [n.id, n]));
const total = [...self.values()].reduce((a, b) => a + b, 0);
[...self].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([id, us]) => {
    const f = byId.get(id).callFrame;
    console.log(`${((us / total) * 100).toFixed(1)}%`, f.functionName || "(anonymous)", `${f.url}:${f.lineNumber}`);
});
```

`(idle)`, `(program)` and `(garbage collector)` rows are the runtime, not app code: a high
`(idle)` share means the capture window was mostly waiting, not that the app is fast.

## Heap sampling: `.heapprofile`

`head` is a tree of `callFrame`, `selfSize` (bytes) and `children`. Sum `selfSize` down each
branch to rank call sites by bytes still live at the stop call. Zero for a site means its
objects were collected, not that it never allocated.

## Heap snapshot: `.heapsnapshot`

A large graph (`nodes`, `edges`, `strings` arrays). Do not read it whole. Load it in Chrome
DevTools' Memory panel and use the Comparison view between two snapshots taken around the
suspect interaction; growth in a class or closure count is the finding.

## Comparing two runs

Same interaction, same session state, same `samplingHz`. Compare self-time shares, not
absolute microseconds: sampling rate and the debug build shift the totals but not the ranking.
