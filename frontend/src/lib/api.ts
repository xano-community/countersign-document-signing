// The domain's API (CRAFT.md §4, the one contract): paths from xano/routes.gen.ts, types from the defs with
// `import type`, every call through `request()`. The base app's own endpoints are in src/base/api.ts.
//
//   import type { InferResponse } from "@xano/sdk";
//   import type { listJobs } from "../../../xano/query/jobs/jobs.js";
//   export type JobPage = InferResponse<typeof listJobs>;
//   export const api = {
//     jobs: (q: { q?: string; status?: string; page?: number } = {}) => request<JobPage>("GET", routePath("GET jobs") + qs(q)),
//     updateJob: (id: number, patch: Partial<Job>) => request<Job>("PATCH", routePath("PATCH jobs/{id}", { id }), patch),
//   };
export { ApiError, XANO_HOST, qs, request, token } from "@/base/request";
export { baseApi } from "@/base/api";
export type { Me, Person } from "@/base/api";

export const api = {};
