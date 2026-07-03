# Contributing to Synthra

Thanks for your interest — bug reports, feature ideas, and PRs are all welcome. This is a small project run by one maintainer, so the process is deliberately lightweight.

## Reporting a bug

The fastest way to a fix is a report I can actually debug:

1. Run `syn doctor --report` (or open the dashboard at `localhost:8901` → **Report** → **Copy report**). It produces a markdown diagnostic with your home paths redacted.
2. Open a [bug report](https://github.com/jefuriiij/synthra/issues/new?template=bug_report.yml) and paste the diagnostic where the template asks for it.

Nothing is ever collected automatically — the diagnostic only leaves your machine when you paste it.

## Suggesting a feature

Open a [feature request](https://github.com/jefuriiij/synthra/issues/new?template=feature_request.yml). Describe the problem you're hitting before the solution you'd like — the problem is usually the more useful half.

## Pull requests

```bash
git clone https://github.com/jefuriiij/synthra
cd synthra
npm install
npm link              # local `syn` now points at your checkout
npm run dev           # tsup --watch
```

Before opening a PR, make sure the full gate is green:

```bash
npm run typecheck && npm run check && npm test && npm run build
```

Guidelines:

- Keep PRs focused — one fix or one feature per PR.
- Add or update tests for anything behavioral (`tests/`, vitest).
- Match the existing code style; `npm run check` (Biome) enforces most of it.
- For anything non-trivial, open an issue first so we can agree on the approach before you spend time on it.

## Developer Certificate of Origin

This project uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). By submitting a contribution, you certify that you wrote it (or otherwise have the right to submit it) under the project's license. Please sign off your commits:

```bash
git commit -s
```

which adds a `Signed-off-by: Your Name <you@example.com>` line to the commit message.

## License of contributions

Synthra is [MIT-licensed](./LICENSE). By submitting a contribution you agree that:

1. Your contribution is provided under the MIT license (inbound = outbound), and
2. You grant the project maintainer ([@jefuriiij](https://github.com/jefuriiij)) a perpetual, worldwide, non-exclusive, royalty-free right to use, modify, sublicense, and **relicense** your contribution as part of Synthra, including under different license terms in future versions.

You retain the copyright to your contribution. This clause simply keeps the project's future licensing options open without needing to track down every past contributor for consent.
