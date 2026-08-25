# Eval case example

Collect 20–50 recent real tasks with expected outcomes. Each eval is one prompt
plus one machine-checkable pass condition. Run the suite non-interactively in CI
on every CLAUDE.md, skill, or hook change. Add an eval after every production
incident.

## Example: duplicate import regression

- **Prompt:** "A user imported `utils.py` twice in `app/main.py`. Find and fix the
  bug, then add a regression test."
- **Expected outcome:** one import statement remains, tests pass, and the diff
  contains a new test covering the duplicate-import case.
- **Pass conditions:**
  - `python -m pytest tests/test_main.py -q` exits 0
  - `grep -c "import utils" app/main.py` prints `1`
- **Added after:** incident INC-123 (2026-05-02)

## Writing your own

- Task: real work the agent has done or should be able to do.
- Prompt: exactly what the agent receives.
- Expected outcome: observable, not a paraphrase of the prompt.
- Pass condition: a command or deterministic check a machine can run.
