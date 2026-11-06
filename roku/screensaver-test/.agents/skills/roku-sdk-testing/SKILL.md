---
name: roku-sdk-testing
description: "Use when a test for an RSG SDK TypeScript component has to be written, read or fixed — what app authors usually call a unit test, though children render for real — rendering a component with render and TestAnchorNode, finding what it built by tag or by prop value, driving a key press through it, snapshotting the rendered tree, or a test whose assertion reads a value from before the update it is asserting on. Not for proving anything on real hardware, and not for a web component test: this renders into an in-process node tree, so its queries are over SceneGraph tags and props rather than a DOM."
# @roku-sdk/ai managed v=1 hash=f619f4f089a4defc6b0f3c06b3027816a88155be5e7eca0daaf3b4a4a189a9ca skills=1 do-not-edit
---

# Testing Components

## Overview

`@roku-sdk/testing-library` renders a component through the same Solid renderer the app
uses, into an in-process tree of plain objects, and hands back queries over that tree. A
test therefore asserts on tags and prop values, never on pixels. `rk create` already
scaffolds `jest.config.mjs` and a passing example test, so writing a test is adding a
file — there is no harness to build first.

Children render for real. The renderer, the reactive graph and every nested component are
the app's own; only the platform edge beneath them is substituted. These are component
tests rather than isolated unit tests, which decides two things: do not mock a child to
get at its parent, and expect a broken child to fail its parent's test.

## When to Use

- writing a test for a component, or reading one that is already there
- asserting that a node rendered, or that one of its props holds a particular value
- driving a D-pad press or any other key event through a component
- snapshotting the rendered tree, and updating that snapshot on purpose
- a test whose assertion reads a value the app gets right, because it ran before the
  update it is asserting on

That last one has one cause and two fixes, both in `references/async-and-timing.md`. Read
it whenever a value is stale, whenever the component under test awaits anything, or before
reaching for a timer.

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Proving behaviour on real hardware | The `mcp-ai-dev-loop` skill, or a `device-tests/` suite | Nothing here touches a Roku. The tree is a JavaScript object, so a passing test says what the component built, not what the screen showed |
| A React or web component test | That library's own documentation | Those render into a DOM and query it by text and role; these queries run over SceneGraph tags and props, and none of them transfer |
| A legacy BrightScript channel | Roku's own BrightScript unit-testing documentation | A different runtime and a different toolchain |
| Adding Jest itself, or a dependency the app is missing | The `project-setup` skill | That is project configuration; this skill starts once `pnpm test` runs |

## Quick Reference

| Task | Do this |
|---|---|
| Render | `const view = await render(() => <TestApp />)` — `render` is async, and an un-awaited one hands back a promise with no queries on it |
| Get something renderable | `const TestApp = TestAnchorNode(App)` at module scope, where `App` is the tuple `defineAnchorNode` returned |
| One node by tag | `getByTag("label")` — tags are the lowercase SceneGraph names: `label`, `rectangle`, `group`, `poster`, `key-handler` |
| Every node by tag | `getAllByTag("label")` |
| One node by prop value | `getByProp("text", "Play")`, or `getByProp("id", "titleLabel")` |
| Tolerate absence | `queryByTag`, `queryAllByTag`, `queryByProp` — `null` or `[]` where the `get` forms throw. There is no `getAllByProp` |
| Read a found node | `props(node)`, `children(node)`, `tag(node)` |
| Press a key | `await fireEvent(getByTag("key-handler"), "onKeyEvent", { key: "right", press: true })` |
| Snapshot the tree | `expect(toString(2)).toMatchSnapshot()` |
| Let a pending update land | `await view.transaction()` |
| End the test | `dispose()` — synchronous, so there is nothing to await |
| Configure Jest | one line in `jest.config.mjs`: `export { default } from "@roku-sdk/dev-tools/jest-config/jest.config.mjs";` |

## Instructions

1. **Wrap the component once, at module scope.** `TestAnchorNode(App)` takes the tuple
   `defineAnchorNode` returned — the component's default export — and returns something
   `render` can mount. Building it inside each test rebuilds the component definition per
   test for no benefit.

2. **`await render(...)`.** It returns the queries, `fireEvent`, `transaction`, `toString`
   and `dispose` in one object; destructure the ones the test uses. The await is not
   ceremony: the first commit of the tree is queued and flushed inside `render`, so without
   it there is nothing to query.

3. **Let the `get` forms be the assertion.** `getByTag` and `getByProp` throw when nothing
   matches, naming the tag or the prop they looked for, so `getByProp("text", "Play")` on
   its own already fails the test if that label is absent. Wrapping it in an `expect` adds
   a line and no information. Reach for `queryByProp` only when absence is the thing being
   asserted, and then assert on the `null` it returns.

4. **Drive input through the key handler node.** Focus and key routing in this SDK end at a
   `key-handler` node, so `getByTag("key-handler")` is the entry point for a press, and the
   payload is `{ key, press }` — `press: true` is the key going down, `false` its release.
   Key names are Roku's: `up`, `down`, `left`, `right`, `OK`, `back`. `fireEvent` is async
   and awaits the resulting commit, so `await` it and then assert directly.

5. **Snapshot with `toString(2)`**, which serializes the tree with an indent of two and
   omits internal node references. It is the whole rendered structure, so it is the right
   tool for "this component still builds what it built" and the wrong one for a single
   value — a snapshot that changes on every edit stops being read.

6. **`dispose()` at the end of every test.** It tears the tree down and releases the
   renderer. Tests that skip it leak state into the next one, and the failure shows up in
   whichever test runs after, not in the one that caused it. It is Solid's disposer and
   returns nothing, so awaiting it is a no-op that reads as though it were async.

## Example

```tsx rsg-skill=complete
/// <reference types="jest" />

import { Label, LayoutGroup } from "@roku-sdk/components";
import type { AnchorNodeDescriptor, AnchorNodeImplementation } from "@roku-sdk/rsg-ts";
import { defineAnchorNode } from "@roku-sdk/rsg-ts";
import { render, TestAnchorNode } from "@roku-sdk/testing-library";

const GreetingDescriptor: AnchorNodeDescriptor = {
    componentName: "Greeting",
    extends: "Group" as const,
    inputFields: {},
    outputFields: {}
};

const GreetingImpl: AnchorNodeImplementation<typeof GreetingDescriptor> = () => (
    <layoutGroup layoutDirection="vert">
        <label id="titleLabel" text="Hello" width={1920} height={100} />
    </layoutGroup>
);

const Greeting = defineAnchorNode(GreetingDescriptor, GreetingImpl);
const TestGreeting = TestAnchorNode(Greeting);

describe("Greeting", () => {
    test("renders the title", async () => {
        const { getByProp, toString, dispose } = await render(() => <TestGreeting />);

        // Throws when absent, so this line is the assertion.
        getByProp("text", "Hello");
        getByProp("id", "titleLabel");
        expect(toString(2)).toMatchSnapshot();

        dispose();
    });

    test("renders no subtitle", async () => {
        const { queryByProp, dispose } = await render(() => <TestGreeting />);

        // The tolerant form, because absence is what is being asserted.
        expect(queryByProp("id", "subtitleLabel")).toBeNull();

        dispose();
    });
});
```

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| `getByProp is not a function`, or every query is `undefined` | `render` was called without `await` | `const view = await render(...)` |
| `No node found with tag name: ...` on a node that is plainly in the JSX | The node's tag is the SceneGraph name, not the component's | Snapshot the tree with `toString(2)` once and read the tags off it |
| `getAllByProp is not a function` | It does not exist — the `All` forms are tag-only | Use `getAllByTag`, or `queryAllByTag` and filter on `props(node)` |
| An assertion reads the value from before the event | The commit had not been applied yet | See `references/async-and-timing.md` |
| A test passes alone and fails in the suite | A previous test never disposed | `dispose()` at the end of every test |
| The snapshot file churns on unrelated edits | A whole-tree snapshot is standing in for a value assertion | Snapshot once for structure; assert values with `getByProp` |
