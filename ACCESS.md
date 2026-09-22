# Working on Flight System from more than one place

GitHub is the single copy of record: `josedelcid1988-lgtm/flight-system` (private).
Everything else (a laptop, a Claude session, a published artifact) is a working
copy of what is on `main`.

## Personal MacBook Air

The clone is at `~/projects/flight-system`.

```bash
cd ~/projects/flight-system
git pull            # before starting
# ... edit index.html / demo.html / tests ...
git add -A && git commit -m "what changed" && git push
```

## Work computer, first time

1. Install the GitHub CLI, then `gh auth login` and pick HTTPS.
2. `gh repo clone josedelcid1988-lgtm/flight-system` into a working folder.

Every time after that: `git pull` before editing, `git push` when done. Pull
first, always: the app is one large HTML document, so two machines editing it
at once produces a conflict that is unpleasant to resolve by hand.

## From a Claude session (either machine)

Claude cannot open a private repo on its own. It reaches the code the same way
you do, through the computer:

1. In the Claude desktop app on that computer, link the session to the computer.
2. Add the repo folder (Add folder), or let Claude request access to it.
3. Ask Claude to pull, make the change, run the tests in TESTING.md, and push.
   Claude runs `git` on that machine with your `gh` login.

Nothing else is needed: no token pasted into chat, no copy of the code sitting
in a chat window.

## Getting only the latest build, without a clone

- Open the repo on github.com and download `index.html` (production) or
  `demo.html` (demo) from the file view.
- Or from any machine with the CLI:
  `gh repo clone josedelcid1988-lgtm/flight-system -- --depth 1`

Both builds are single HTML files and run by opening them in a browser.

## Keeping the two machines straight

- Commit and push before you leave a machine. An unpushed change is invisible
  to the other one.
- `git log --oneline -5` shows what the last session did.
- The product build id is written only in `VERSION.md`. `TESTING.md` says how to
  test it.
