# Redesigning source control at Anthropic

This is an audio adaptation of Anthropic’s research post [Redesigning source control at Anthropic](https://www.anthropic.com/research/redesigning-source-control) (updated October 15, 2026), written by Nick G. and the source control team. Coding is no longer the bottleneck. Claude iterates research loops, micro-optimizes programs, and stands up services faster than human-scale git, CI, and review can absorb. Anthropic’s answer was **Scion**, an in-house version control system, plus a review surface called **Antique**. They migrated the monorepo off git in five months.

## The scale that broke git

In May 2026 they averaged about **2,500 merges per day**. By September it was **over 30,000**. They do not expect that growth to slow: latent demand for merging is “practically infinite.” A chart in the post shows daily merges to the monorepo climbing steeply from January through September 2026.

The monorepo is an unusual workload, but they expect other AI-heavy orgs to hit the same pressure points. Git is decentralized: every clone is a complete repo that can diff, blame, and check out offline. That is why git won. It is also why this repo no longer fits.

- History of `main` alone: almost **100 GB**.
- Compressed working copy: over **25 GB**.
- On the order of **25 million CI checkouts per day**, before developer machines, agent sandboxes, and research jobs.
- Fetched naively: over **600 petabytes** of git traffic per day.

They used the standard toolkit—shallow clones, sparse checkouts, promisor remotes, internal mirrors, blob-storage seeds. At peak they ran **several hundred git mirrors**. Seeds drifted from tip of main; history operations on partial clones got fragile. They were using git as a centralized system with one authority, while almost every client was an always-online agent or job. The offline, full-clone properties were undermining scale.

## Principles for agent-scale source control

Prior art: Google’s [Piper](https://en.wikipedia.org/wiki/Piper_(source_control_system)) and Meta’s [Sapling](https://sapling-scm.com/), especially the server **Mononoke** and its **Bonsai** data model. Scion’s principles:

1. **Clients are always online.** Fetch on demand from a reachable server.
2. **Client–server asymmetry.** The server does history, blame, commits, merges, rebases. The client is a bounded object cache, working-copy layout, filesystem watcher, and ergonomic UI. It computes very little; it stores much less.
3. **A source-control service as a platform.** The same queries the client uses are APIs. Jobs often need no local repo. Automated bisect and revert only work at this scale because ancestry and blame are cheap RPCs.
4. **Everything horizontally scalable.** No fully materialized copy of the repo anywhere, even on the server. No packfiles, so no repo maintenance.
5. **Commits cheap, incremental, lock-free.** Create, rebase, merge happen on the server; there is nothing to push. Cost must scale with the *change*, not the repo. They discourage refs except `main` and release branches: global state every server must agree on is a scaling cliff.
6. **Working copy optional, sparse by design.** Need a diff vs merge-base? Ask the server. Sparse checkouts only include requested directories; virtualized checkouts materialize files on read.

## How Scion works

### Changesets, not git commits

The unit of work is a **changeset**: an entry in a write-ahead log. It stores most of what a git commit would, but instead of pointing at a full tree it stores **the files that changed relative to its first parent**, plus content-addressed pointers to compressed blobs. Changesets are created server-side and are available everywhere immediately.

A figure in the post shows that shape: parent pointer, changed-path list, blob hashes—no full tree snapshot.

No packfiles to accept, no locking or cross-server coordination, no refs to move on the commit path. Refs exist, but moving one is a compare-and-swap on a **single Spanner row**, separate from creating the changeset.

**Aside on first-parent diffs.** Storing the delta vs the first parent of a merge is a trunk-based choice: in a monorepo people almost only care about history and blame on the main line. Side-branch file identity is less important than “what landed on main.”

**Aside on Bonsai.** Meta’s Bonsai changeset is the same idea: a commit is a structured list of file changes plus metadata, not a git-style snapshot of every tree. Derived data (manifests, blame, copy detection) is computed from that log. Scion’s “changeset + derived data” is that lineage, on Spanner instead of Mononoke’s backends.

A changeset alone cannot answer “who last edited this line?” Scion builds **derived data** from the log: blame, path history, skip lists on the commit graph. Each type is defined recursively: the value for a changeset is computed from its parents. Benefits: new types are easy (copy detection, path search); each type can be eager or lazy; clients never see internals, so they can rewrite indices without a client bump.

### The fleet

A small fleet of Scion servers answers get-changeset, diff, merge-base, blob fetch. All data is content-addressed and immutable, so any server can cache without coordination. Servers are large caches that also compute derived data and write it back to Spanner.

Early in the migration, before they had their own client, Scion only answered **metadata** queries. Content and working copies needed a different protocol.

The `scn` client does **not** tell the server what it already has (git’s have/want negotiation). It asks only for trees and blobs it wants. From a root tree it fills missing trees recursively, then blobs. Every request is for an immutable object, so it looks like a **tiered cache**, not a packfile conversation. Sparse and virtual checkouts need no special case: the client simply does not ask for unwanted trees.

On a node, the client talks over a socket to **scion-daemon**, which stores objects for the whole machine. Jobs on the same node reuse objects. Each daemon starts from a periodically refreshed snapshot, then talks only to regional **scion-cache** servers. Caches stream objects from memory **in the disk format the daemon will write**—no delta compression, no computing a custom pack. Misses go to authoritative **scion-servers**, which read Spanner or cloud storage.

All three tiers speak the same RPCs; the client does not know the topology. They **enforce** the tiers so a regional cache failure cannot stampede the origin.

**Results they report:** each tier >**99%** cache hit rate; infrastructure footprint **200× smaller** in CPU and memory than git mirrors; CI/research checkouts **two orders of magnitude faster** (seconds vs minutes); CI alone a **25% CPU capacity** win. No repo maintenance on clients or caches.

## What they learned

They started Scion around the time **Claude Mythos Preview** and **Claude Tag** were available internally. Those models both created the merge flood and sped up building the system that absorbed it.

Example: they had handwritten a git-to-Scion ingestion pipeline. An early Mythos snapshot, asked to rewrite it with no further instructions, produced a version that used **20× less memory** and was **4× faster**, keeping ingestion-order invariants. A chart of weekly merges into the Scion and Antique codebases themselves climbs through 2026.

Lessons:

**Small teams, fast migrations.** Seven people built Scion, Antique, and half a dozen related systems, and fully migrated in five months while daily merges grew 10×. Historically this class of VCS took years and many more engineers.

**Engineers are not less valuable; the work changed.** Those engineers now rate Claude as better at *writing* code than they are. They still own inter-system design and tradeoffs. Very often the job was to tell Claude **no**: agents violate core constraints to satisfy a pattern that should never have been allowed. Example: systems brute-force “when did this merge to main?” by linearly reading the log instead of asking the review tool. Adversarial review is effective but myopic; humans had to stop over-engineering in response to hypothetical distrust of other internal services. They still review every change—**intent**, not every line.

**Tests and optimizations got denser.** Even on a tight timeline they built hermetic simulations of every non-trivial infra interaction, plus fuzzing and rate limiting. Claude found optimizations (e.g. ancestry queries missing an index) that would have taken an expert days. A figure shows observed performance improvements on native Scion repos.

**Monorepo security as a first-class design.** Rich repo ACLs and **per-directory permissions** so sensitive code can live in the monorepo. Antique can express semantic approval constraints (comment-only vs logical change) so humans spend attention on consequential diffs.

**Ops via “superfans.”** Slack channels where Claude Tag is tasked to obsess over one component—scion-daemon, scion-cache, Antique merge queue—with telemetry and logs. Traditional alerts still exist; superfans catch subtle, novel issues that make static alerts look one-dimensional.

**Priors that no longer hold.** A classic **global merge-queue lock** does not make sense when hundreds or thousands of changes can land while tests run. They invested in **post-merge and pre-deploy** automated testing. Concurrent changes can conflict; Claude typically fixes conflicts faster than humans notice them.

## They are not shipping Scion as git-for-everyone

Scion is not a general git replacement. It only makes sense for enormous monorepos—tens of thousands of engineers or swarms of agents. Anthropic’s internal token spend is also unlike a typical company.

They will not open-source a public Scion: it diverges from git, and review, search, and CI are bespoke. Trying to please everyone would not be useful.

What they want instead: steal the ideas **inside git**. A git *server* need not work like a git *client*. Server-side RPCs for history, diff, and blame could be standardized across forges. Negotiation need not be have/want. Sparse and shallow features should compose. They frame this as a narrow contribution to GitHub, GitLab, and OSS: an early look at how agentic development stresses these systems.

## The conversation

[Simon Willison](https://simonwillison.net/2026/Oct/13/redesigning-source-control-at-anthropic/) summarized the numbers and noted the Subversion-like centralization: offline was deprioritized because Claude is always online. [The Pragmatic Engineer](https://blog.pragmaticengineer.com/the-pulse-anthropic-builds-its-own-source-control-system/) treated it as a pulse item for large-monorepo shops, not a signal to abandon git. The pushback, including Anthropic’s own, is consistent: **do not copy Scion; copy the server-side query and sparse-fetch ideas** when git mirrors start to hurt.

## Why it matters for you

If you run an engineering org, the useful questions are not “should we write a VCS?” They are: where is **human-scale infra** the bottleneck for agent throughput (checkout time, blame, merge queue, review attention)? Which queries should be **RPCs** instead of local clones? And as merge volume rises, does a locked merge queue still match how you actually ship, or do you need post-merge repair as a first-class path?

## Key takeaways

- Agent coding moved Anthropic from ~2,500 to 30,000+ merges/day; git-as-full-clone became the bottleneck (100 GB history, ~25M CI checkouts/day).
- Scion is a centralized, always-online VCS: changesets as a write-ahead log, derived data (blame, history) computed recursively, immutable objects served through a three-tier cache.
- They report 200× smaller infra than git mirrors, checkouts in seconds, 25% CI CPU win; seven people, five months, plus Antique.
- Engineers shifted from writing lines to saying no, reviewing intent, and designing constraints; merge-queue locks gave way to post-merge testing.
- Scion is not a git replacement; the portable idea is server-side source-control APIs and sparse, cacheable fetches.

## Sources

- [Redesigning source control at Anthropic](https://www.anthropic.com/research/redesigning-source-control) — Nick G. and the source control team (S.G., R.K., Dan C., Garrett H., Ben L., Colin M., Joe P.); acknowledgements to Vilas J., Sergiu D., Amir O.
- [Mononoke README](https://github.com/facebook/sapling/blob/main/eden/mononoke/README.md) and [Bonsai types](https://github.com/facebook/sapling/blob/79071c2a3ea20c36ed71332608535e5801101bba/eden/mononoke/mononoke_types/serialization/bonsai.thrift#L50)
- [Piper (Wikipedia)](https://en.wikipedia.org/wiki/Piper_(source_control_system)), [Sapling](https://sapling-scm.com/)
- [Simon Willison’s notes](https://simonwillison.net/2026/Oct/13/redesigning-source-control-at-anthropic/)
- [The Pragmatic Engineer Pulse](https://blog.pragmaticengineer.com/the-pulse-anthropic-builds-its-own-source-control-system/)
- [Claude Mythos](https://www.anthropic.com/claude/mythos), [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag)
