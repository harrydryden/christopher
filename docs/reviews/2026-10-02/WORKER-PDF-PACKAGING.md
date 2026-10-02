# Worker PDF packaging failure

## Production evidence

The reported Splose CV build ran on merged commit `1cee7df802f83a65f43b24762748c7c62788fcfd`. Read-only production diagnostics confirmed that the requirements were reused and the evidence plan, writing and plan validation completed. PDF measurement then failed with `Cannot find module '#standard-fonts/Helvetica'`, required from `/app/apps/worker/dist/index.mjs`.

This is a runtime packaging failure in the PDF renderer. It is distinct from the earlier requirements and evidence-reference validation failures, but still prevents the user from completing the same CV workflow.

## Cause and test gap

The worker bundles workspace dependencies into an ES module. PDFKit was a transitive workspace dependency rather than an external worker dependency. Its dynamically loaded standard fonts depend on the package's own `imports` map. Moving that code into the worker bundle changes the resolution context and loses the mapping.

Source tests run with the package in its original location and therefore did not reproduce this. The previous Docker check only booted the worker and checked its health endpoint; it never called the PDF renderer.

## Required verification

Keep PDFKit in its original package scope at runtime. Verify the actual built worker entry point with plain Node, including standard and embedded fonts, and run that check inside the final Docker image. The verification must render PDF bytes and check the page count, not merely import the module or start the health server. It must not require a database or a paid model call.

This packaging check establishes that the runtime can render CV PDFs. It does not replace a live end-to-end model evaluation.

## Results

- Reproduced the exact missing-Helvetica exception from the compiled worker before adding the runtime dependency.
- The corrected compiled worker renders both AVA (standard Helvetica) and Arial (embedded Liberation Sans) PDFs.
- The final Docker image builds successfully and runs the renderer check as `pwuser`, using the production Node flags and tracing preload. The same check also passes with container networking disabled.
- Worker typechecking and frozen-lockfile installation pass. All 66 focused CV layout, export and theme tests pass.
- This change does not alter model prompts or evidence validation. A production deployment and retry remain separate from these local runtime checks.
