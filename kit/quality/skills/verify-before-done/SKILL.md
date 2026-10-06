---
name: verify-before-done
description: "Before saying done, works, or fixed, runs the command or check that proves it right now (tests, build, running the program, opening the page), shows the output, and says what is missing when there is no proof. Use when work seems finished, before a summary, or when the user asks whether it really works."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "testing"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "bitti demeden önce, kanıtla*, gerçekten çalışıyor mu, kanıt göster*, emin misin, gerçekten düzeldi mi"
---

# Verify before done

"Done" is a claim. This skill turns it into a fact: run the check that proves the claim **now**, look at what it
printed, and only then say the word. It takes a minute and saves the user from finding out later.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Name the claim

Say what you are about to claim in one sentence: "the login form rejects an empty email", "the project builds", "the
bug is gone". Each claim needs its own proof; a proof for one does not cover another.

## 2. Pick the proof

| The claim | The proof |
|---|---|
| Code works | the tests that cover it, then the whole suite |
| A bug is fixed | the test that reproduced it, now green, and the steps that failed before |
| The project builds or starts | the build command, or starting the program and reading its first output |
| A page or screen looks right | open it and look (browser, or the engine's play mode); tell the user what to see |
| A file or setting changed | read it back, do not trust the edit |
| A helper said it finished | read its report file and run the check yourself |

If the project has no way to prove the claim, say that, and write two or three manual steps for the user instead
("open this, click that, you should see this").

## 3. Run it fresh

Run the proof **now**, after the last change. Output from before the last edit does not count. Read the result
yourself: exit status, the counts, the first error line. Then show the user the command and the key lines of its
output.

## 4. Say it, or say what is missing

- The proof passed: "Done: `<command>` printed `<key line>`." Plainly, without decoration.
- The proof failed: say so, with the failing line, and go back to fixing. Do not call it done.
- There is no proof (no test, cannot run it, only a person can see it): do not say done. Say "Not verified yet:
  <what is missing>", and give the manual steps or the command the user can run.

## Common ways out

Short, kind answers to the usual excuses:

- "It is a small change." Small changes break things too; the check is a single command.
- "It worked a minute ago." Then it costs one minute to show it still does.
- "The tests passed earlier." Earlier is before your last edit; run them again.
- "The helper said it is done." That is its report, not your proof.
- "It should work." "Should" is a guess; run it.

## Never

- Say done, fixed or works, or tick a "done when" item, without proof from this session.
- Change a test or a check so that it passes.
- Hide a failing line or a warning that appeared in the output.

## Done when

The claim has a fresh command or check behind it and the user saw its output, or you said plainly what is not
verified and how they can check it.

Do not use for: writing tests first (`test-first`), or finding why something fails (`debug-helper`).
