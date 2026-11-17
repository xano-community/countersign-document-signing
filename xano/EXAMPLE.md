# Building your countersign backend

The backend lives in [`index.ts`](index.ts) and is a single default-exported
`workspace()`. You grow it by registering typed objects.

## Learn the library from the library

Read `node_modules/@xano/sdk/llms.txt` in full first; it ends with the topic files
(`node_modules/@xano/sdk/llms/*.md`) and the condition for opening each. Author against
the published types (`node_modules/@xano/sdk/**/*.d.ts`), and grep
`node_modules/@xano/sdk/manifest.json` for one entry's full detail. Don't invent an API
that isn't there.

## The shape

```
xano/
├── index.ts          default export: the workspace registering everything below
├── tables/<name>.ts  a table (name, typed schema, indexes)
├── api/<group>.ts    an API group; pin its canonical slug so paths are stable
└── api/<endpoint>.ts a query: name, verb, apiGroup, typed input, a stack, a response
```

## Steps

1. **Define a table** under `tables/` with `table({ name, schema: { ... } })`.
   `id` and `created_at` are auto-injected.
2. **Define an API group** with `apiGroup({ name, canonical })`. Pinning the
   canonical slug keeps the public path stable and lets `npm run xano:routes`
   resolve it without a lock file.
3. **Define endpoints** with `query({ name, verb, apiGroup, input, ... })`, building
   the logic from the `s.*` statement helpers and the expression/column/input/
   reference helpers.
4. **Register everything** in `index.ts`:
   ```ts
   export default workspace("countersign")
     .registerTables([...])
     .registerApiGroups([...])
     .registerQueries([...]);
   ```
5. **Assert it works** — add a `tests: [...]` entry to a query or function
   (named inputs plus `expect.*` assertions on its response), or a
   `workflowTest({ name, stack })` when the behavior spans several objects.
   They live beside the code they cover and ship with it. See "Testing" below.
6. **Compile** with `npm run xano:export`, and **deploy** with
   `npm run xano:deploy` (it runs on the Xano Engine; no account needed). The first of either writes
   `xano/xano.lock` — **commit it**. It pins every object's identity, so a later
   rename renames the object instead of deleting and recreating it. See
   "`xano.lock` — commit it" in the project README.

## Testing

Unit tests (`tests: [...]` on a query, function or middleware, asserting with `expect.*`)
and workflow tests (`workflowTest({ name, stack })`, asserting with `s.expect.*`) both
run against what is DEPLOYED:

```bash
npm run xano:deploy    # deploy first
npm run xano:test      # runs both kinds; exits 5 if any fail
```

Read `node_modules/@xano/sdk/llms/tests.md` before authoring either kind.

### Event-driven objects

A scheduled `task`, an `mcpServer`, and every trigger **run once deployed**,
on the Xano Engine and an ephemeral alike — test them by deploying and letting
them run.

## Wire the frontend

In [`../frontend/src/lib/api.ts`](../frontend/src/lib/api.ts), never hand-type a
URL or a request body:

- **Paths and verbs** come from `xano/routes.gen.ts`:
  `routePath("POST create_note")`, `ROUTES["POST create_note"].verb` (a verb+name two api
  groups share is keyed `"<group>:<VERB> <name>"`). Run
  `npm run xano:routes` after adding or renaming an endpoint (`dev`, `build` and
  `typecheck` also run it) and commit the file.
- **Request types** come from the same file: `RouteInputs["POST create_note"]`
  (`ChannelInputs`/`MessageInputs` for realtime). For runtime validation,
  `npx @xano/sdk marketplace install zod` adds zod schemas under the same keys.
- **Response types** come from the defs with `import type` — `InferResponse`
  erases to nothing.
- Never import a def as a value in the frontend. Its `s.*`/`c.*` stack calls run
  at module load, so one import for its `getPath()` pulls the backend graph it
  references and the SDK runtime into the bundle.
