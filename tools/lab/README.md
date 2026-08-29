# Lab database utilities

Read-only-by-default Python tools for inspecting and repairing lab data. They live here because
**this repository is the one actually checked out on the lab VM and kept current** — the
`cddos-legacy` monorepo checkout there sits on an old commit, so anything kept only in its `tools/`
has to be `scp`-ed in every time, and `/tmp` is wiped whenever the portal container is recreated.

| Tool | What it does |
|---|---|
| `lab_validate.py` | 18 read-only constraints over the lab database. Exits 1 on an unexpected ERROR, 0 otherwise. `--expect` declares known violations so drift is reported instead of silence; `--json` for machine output |
| `expected-violations.yaml` | the declared violations `--expect` reads — deliberate fixtures, each with its reason |
| `lab_repair_gre.py` | one-shot GRE tunnel-ledger repair. Dry run by default, idempotent |
| `lab_clone_sc3_fixture.py` | clones DPs and access routers into a target SC by management IP, renumbering tunnels and picking VLANs outside the in-use set |

## Running

They run **inside a portal container**, which supplies the Mongo connection from its own environment:

```bash
docker cp tools/lab/lab_validate.py legacy-portal-portal-1:/tmp/lab_validate.py
docker cp tools/lab/expected-violations.yaml legacy-portal-portal-1:/tmp/expected.yaml
docker exec legacy-portal-portal-1 python /tmp/lab_validate.py --expect /tmp/expected.yaml
```

From Git Bash on Windows, prefix `MSYS_NO_PATHCONV=1` or the container path is rewritten into a
Windows one.

**Re-copy after any rebuild.** `make portal-rebuild` / `docker compose up` recreates the portal
container and `/tmp` goes with it.

## Provenance

Copied from `cddos-legacy` `tools/` and `lab/`. **Two copies now exist and will drift** — that is a
known cost, accepted so the lab has them without a monorepo pull. Deciding the single home is on the
backlog, together with whether `sdcc-tests` and `sdcc-services-qa` should be one repository at all.
